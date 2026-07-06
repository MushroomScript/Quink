import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { resolve } from 'path';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { toPinyinSearchable } from '../utils/pinyin.js';
import { nanoid } from 'nanoid';
import { DB_PATH, UPLOAD_DIR } from '../config/paths.js';

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

// Auto-create tables on first run
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nickname TEXT NOT NULL,
    avatar TEXT,
    preferences TEXT DEFAULT '{}',
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    summary TEXT,
    summary_locked INTEGER NOT NULL DEFAULT 0,
    category TEXT,
    tags TEXT DEFAULT '[]',
    type TEXT NOT NULL DEFAULT 'quink',
    todo_status TEXT,
    todo_due TEXT,
    ai_processed INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 系统只支持一级分类, 不再有 parent_id (旧 DB 启动迁移会 DROP COLUMN)
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    url TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    category TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_configs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT,
    model TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_prompts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    feature TEXT NOT NULL,
    prompt TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS ai_conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL DEFAULT '新对话',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sources TEXT DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS voice_transcriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    audio_url TEXT NOT NULL,
    text TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    parent_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reminder_channels (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    avatar TEXT,
    invite_token TEXT,
    invite_expires_at TEXT,
    auto_join INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'active',
    joined_at TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_join_requests (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    invite_token TEXT,
    created_at TEXT NOT NULL,
    handled_at TEXT,
    handled_by TEXT REFERENCES users(id)
  );

  -- 群组共享: 笔记 → 群组多对多, sharedAt 给群 feed 排序
  CREATE TABLE IF NOT EXISTS note_shares (
    note_id TEXT NOT NULL REFERENCES notes(id),
    group_id TEXT NOT NULL REFERENCES groups(id),
    shared_at TEXT NOT NULL,
    PRIMARY KEY (note_id, group_id)
  );
  -- 群 feed 查询: SELECT * FROM note_shares WHERE group_id=? ORDER BY shared_at DESC
  CREATE INDEX IF NOT EXISTS idx_note_shares_group_shared ON note_shares(group_id, shared_at DESC);
  -- 删笔记 / 取消分享: DELETE FROM note_shares WHERE note_id=?
  CREATE INDEX IF NOT EXISTS idx_note_shares_note ON note_shares(note_id);

  -- 群内独立置顶 (跟 notes.pinned 作者全局置顶完全分离). owner/admin 操作, 多群独立
  CREATE TABLE IF NOT EXISTS group_note_pins (
    group_id TEXT NOT NULL REFERENCES groups(id),
    note_id TEXT NOT NULL REFERENCES notes(id),
    pinned_by TEXT NOT NULL REFERENCES users(id),
    pinned_at TEXT NOT NULL,
    PRIMARY KEY (group_id, note_id)
  );
  -- 群 feed 排序: LEFT JOIN group_note_pins ORDER BY (pinned_at IS NOT NULL) DESC, pinned_at DESC, shared_at DESC
  CREATE INDEX IF NOT EXISTS idx_group_note_pins_group_pinned ON group_note_pins(group_id, pinned_at DESC);

  -- 编辑权限白名单 (申请通过后永久授权, 作者/admin 可撤销)
  CREATE TABLE IF NOT EXISTS note_edit_grants (
    note_id TEXT NOT NULL REFERENCES notes(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    granted_at TEXT NOT NULL,
    granted_by TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (note_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_note_edit_grants_user ON note_edit_grants(user_id);

  -- 编辑权限申请记录 (status 保留历史: pending / approved / rejected / canceled)
  CREATE TABLE IF NOT EXISTS note_edit_requests (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    message TEXT,
    created_at TEXT NOT NULL,
    handled_at TEXT,
    handled_by TEXT REFERENCES users(id)
  );
  -- 作者/admin 看某笔记的 pending 申请: WHERE note_id=? AND status='pending'
  CREATE INDEX IF NOT EXISTS idx_note_edit_requests_note_status ON note_edit_requests(note_id, status);
  -- 申请人查自己所有申请: WHERE user_id=? ORDER BY created_at DESC
  CREATE INDEX IF NOT EXISTS idx_note_edit_requests_user ON note_edit_requests(user_id, created_at DESC);

  -- 表情 reaction: 共享笔记快速表态. (note_id, user_id, emoji) 复合主键防重复
  CREATE TABLE IF NOT EXISTS note_reactions (
    note_id TEXT NOT NULL REFERENCES notes(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (note_id, user_id, emoji)
  );
  -- 列某笔记所有 reaction: WHERE note_id=? GROUP BY emoji (复合主键 (note_id, user_id, emoji) 已自带 note_id 前缀索引, 不需额外)

  -- 每人完成待办 (todoGroupMode='everyone') 的 per-user 完成记录. 有记录=该用户完成. (note_id, user_id) 复合主键防重复
  CREATE TABLE IF NOT EXISTS note_todo_done (
    note_id TEXT NOT NULL REFERENCES notes(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    done_at TEXT NOT NULL,
    PRIMARY KEY (note_id, user_id)
  );

  -- 评论 thread: 单层 thread (parent_id 二级及以下 normalize 到根 parent), 软删 deleted_at
  CREATE TABLE IF NOT EXISTS note_comments (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    parent_id TEXT REFERENCES note_comments(id),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  -- 列某笔记所有评论: WHERE note_id=? AND deleted_at IS NULL ORDER BY created_at ASC
  CREATE INDEX IF NOT EXISTS idx_note_comments_note_created ON note_comments(note_id, created_at);

  CREATE TABLE IF NOT EXISTS reminder_pending (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  -- 上线补送只查 unsent (sent_at IS NULL)
  CREATE INDEX IF NOT EXISTS idx_reminder_pending_user_unsent ON reminder_pending(user_id, sent_at);

  -- 邀请 token 反查群组用 (invite/:token 路由)
  CREATE INDEX IF NOT EXISTS idx_groups_invite_token ON groups(invite_token);
  -- 用户的待审申请列表 (owner 看 join-requests pending 用 group_id, 申请人看自己用 user_id)
  CREATE INDEX IF NOT EXISTS idx_join_requests_group_status ON group_join_requests(group_id, status);
  CREATE INDEX IF NOT EXISTS idx_join_requests_user ON group_join_requests(user_id);
`);
// Migrate: notes.todo_remind_sent_at + todo_remind_rrule (提醒功能, 复用 todoDue 作触发时间)
try { sqlite.exec('ALTER TABLE notes ADD COLUMN todo_remind_sent_at TEXT'); } catch {}
try { sqlite.exec('ALTER TABLE notes ADD COLUMN todo_remind_rrule TEXT'); } catch {}
// Migrate: notes.summary_locked (蘑菇 2026-07-06 手动删摘要不让 AI 自动回填)
try { sqlite.exec('ALTER TABLE notes ADD COLUMN summary_locked INTEGER NOT NULL DEFAULT 0'); } catch {}
// Migrate: files.folder_id (资源页文件夹: null = 根目录, 非 null = 在指定 folders.id 下)
try { sqlite.exec('ALTER TABLE files ADD COLUMN folder_id TEXT'); } catch {}

// Migrate: add deleted_at column if not exists
try { sqlite.exec('ALTER TABLE notes ADD COLUMN deleted_at TEXT'); } catch {}
// Migrate: files.filename_history(JSON 数组,重命名时记录所有曾用过的 displayName,让"曾经是文件名的 label"也能识别为可同步)
try { sqlite.exec('ALTER TABLE files ADD COLUMN filename_history TEXT'); } catch {}
// Migrate: 把 /api/uploads/ 前缀从 files.url + notes.content 里 REPLACE 掉(新格式 url 裸名,渲染层拼前缀)。
// 用 WHERE LIKE 限制只 update 还残留前缀的 row,后续启动 LIKE 不匹配自然跳过,反复跑无害。
try { sqlite.exec(`UPDATE files SET url = REPLACE(url, '/api/uploads/', '') WHERE url LIKE '/api/uploads/%'`); } catch {}
try { sqlite.exec(`UPDATE notes SET content = REPLACE(content, '/api/uploads/', '') WHERE content LIKE '%/api/uploads/%'`); } catch {}
// Migrate: 老笔记从 note/snippet 转成 todo 时, PATCH 路由只改 type 不碰 todo_status, 字段保持 NULL,
// 导致 sidebar 徽章 (严格 = 'pending') 漏算; 前端 Todos.vue (!= 'done') 又算上, 两边数字对不齐.
// 路由已修(转 todo 时自动补 'pending'), 此处一次性修存量 NULL → 'pending'. WHERE 限制反复跑无害.
try { sqlite.exec(`UPDATE notes SET todo_status = 'pending' WHERE type = 'todo' AND todo_status IS NULL`); } catch {}
// Migrate: preferences.fontSize (12-22 px, 老的 rem-based 字号缩放) → preferences.zoomLevel (75-200 %, 新的 Electron setZoomFactor 缩放)
// 改 zoom 后所有元素同比 scale, 永久解决跨字号 round 奇偶对齐问题. 老 fontSize 按比例映射到最近的新档位 (8 档 75/80/90/100/110/125/150/200)
// WHERE 限制只动还有 fontSize 字段且没 zoomLevel 字段的 row, 反复跑无害
try { sqlite.exec(`UPDATE users SET preferences = json_set(json_remove(preferences, '$.fontSize'), '$.zoomLevel',
  CASE json_extract(preferences, '$.fontSize')
    WHEN 12 THEN 75
    WHEN 13 THEN 80
    WHEN 14 THEN 90
    WHEN 15 THEN 90
    WHEN 16 THEN 100
    WHEN 17 THEN 110
    WHEN 18 THEN 110
    WHEN 20 THEN 125
    WHEN 22 THEN 125
    ELSE 100
  END
) WHERE json_extract(preferences, '$.fontSize') IS NOT NULL AND json_extract(preferences, '$.zoomLevel') IS NULL`); } catch {}
// Migrate: notes.content_pinyin (拼音搜索支持: 全拼 + 首字母拼接串,搜索时 LIKE %query% 命中)
try { sqlite.exec('ALTER TABLE notes ADD COLUMN content_pinyin TEXT'); } catch {}
// Migrate: notes.visibility (群组共享: private | shared, 默认 private 让现有笔记无侵入)
try { sqlite.exec("ALTER TABLE notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'"); } catch {}
// Migrate: 编辑锁 4 列 (仅 shared 笔记走锁逻辑, private 不需要协作). edit_lock_by/token/expires_at 联动表示当前持锁状态;
// version 乐观锁兜底, 默认 1, PATCH 时 server 校验 version === DB 版本 + version++.
try { sqlite.exec('ALTER TABLE notes ADD COLUMN edit_lock_by TEXT REFERENCES users(id)'); } catch {}
try { sqlite.exec('ALTER TABLE notes ADD COLUMN edit_lock_token TEXT'); } catch {}
try { sqlite.exec('ALTER TABLE notes ADD COLUMN edit_lock_expires_at TEXT'); } catch {}
try { sqlite.exec('ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1'); } catch {}
// Migrate: notes.edit_permission (admin/all). 老 shared 笔记自动归 'admin' (默认收紧), 收紧权限.
// 这是行为破坏更新 (此前默认 all, 现默认 admin), dev 环境 OK
try { sqlite.exec("ALTER TABLE notes ADD COLUMN edit_permission TEXT NOT NULL DEFAULT 'admin'"); } catch {}
// Migrate: COW 分叉模型 - notes.parent_note_id 自引用 root note (默认 NULL = root).
// SQLite ALTER TABLE 不支持加 FK 约束, 跟其他自引用 (folders.parent_id / noteComments.parent_id) 同款弱约束业务保证.
try { sqlite.exec('ALTER TABLE notes ADD COLUMN parent_note_id TEXT'); } catch {}
// 修改历史表 (空间换简洁, 只记 who+when 不存 content snapshot, 给 UI "@B、@C 编辑过" 用)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS note_edit_history (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    edited_at TEXT NOT NULL
  );
  -- 列某笔记编辑历史: WHERE note_id=? ORDER BY edited_at DESC
  CREATE INDEX IF NOT EXISTS idx_note_edit_history_note ON note_edit_history(note_id, edited_at DESC);
`);
// type 字段值跟 UI 对齐迁移 (migration v1). 单次跑后写 config flag 防重复
// (反复跑会把新含义的 'note' 又错误改成 'quink'). 旧值映射:
//   'snippet' (旧"笔记"页) → 'note'
//   'note' (旧"灵感"页)   → 'quink'
//   'link' → DELETE (废弃类型, 当前 DB 无 type=link 笔记, 安全删)
// CASE 一次性表达式行级求值不会有"snippet 改 note 后又被 note 规则改 quink"的 race.
try {
  const row = sqlite.prepare("SELECT value FROM config WHERE key = 'type_field_migration_v1'").get() as { value: string } | undefined;
  if (!row) {
    sqlite.transaction(() => {
      const deleted = sqlite.prepare("DELETE FROM notes WHERE type = 'link'").run();
      const updated = sqlite.prepare(`UPDATE notes SET type = CASE
        WHEN type = 'snippet' THEN 'note'
        WHEN type = 'note' THEN 'quink'
        ELSE type
      END WHERE type IN ('snippet', 'note')`).run();
      sqlite.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run('type_field_migration_v1', JSON.stringify(true));
      console.log(`[type migration v1] deleted ${deleted.changes} link notes, updated ${updated.changes} notes (snippet→note, note→quink)`);
    })();
  }
} catch (e) { console.error('[type migration v1] failed:', e); }

// Migrate: 群公告 (groups 表加 3 列). owner/admin 可编辑, 全群唯一
try { sqlite.exec('ALTER TABLE groups ADD COLUMN announcement TEXT'); } catch {}
try { sqlite.exec('ALTER TABLE groups ADD COLUMN announcement_updated_at TEXT'); } catch {}
try { sqlite.exec('ALTER TABLE groups ADD COLUMN announcement_updated_by TEXT REFERENCES users(id)'); } catch {}

// users 加 token_version 字段, 改密码时 ++ 立即让旧 token 失效
try { sqlite.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0'); } catch {}

// group_members 加 hide_presence 字段, 用户可在某群隐身 (上下线不推 presence-changed 但仍能收事件)
try { sqlite.exec('ALTER TABLE group_members ADD COLUMN hide_presence INTEGER NOT NULL DEFAULT 0'); } catch {}

// 操作审计日志表. 全后端所有写 endpoint 关键位置调 logAudit(userId, action, ...)
// 文本字段为主, 索引按 user_id + created_at 查最近活动
try { sqlite.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    meta TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  );
`); } catch {}
try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs(user_id, created_at DESC)'); } catch {}
try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)'); } catch {}

// legacy cleanup: notes.todo_due / todo_remind_rrule / todo_remind_sent_at 三列已迁到 note_personal_reminders 表 (personal_reminder_migration_v1).
// SQLite 3.35+ 支持 DROP COLUMN, better-sqlite3 默认 3.45+. try-catch 防老 sqlite + 字段已删时 ALTER 失败
try { sqlite.exec('ALTER TABLE notes DROP COLUMN todo_due'); } catch {}
try { sqlite.exec('ALTER TABLE notes DROP COLUMN todo_remind_rrule'); } catch {}
try { sqlite.exec('ALTER TABLE notes DROP COLUMN todo_remind_sent_at'); } catch {}

// 群组回收站: admin 删别人共享笔记时填 deleted_by_user_id + deleted_in_group_id,
// 群 owner/admin 通过 deleted_in_group_id 查群回收站. NULL = 作者自己删 (走个人回收站).
// ALTER TABLE 不支持加 FK, 跟 edit_lock_by / parent_note_id 同款弱约束业务保证.
try { sqlite.exec('ALTER TABLE notes ADD COLUMN deleted_by_user_id TEXT'); } catch {}
try { sqlite.exec('ALTER TABLE notes ADD COLUMN deleted_in_group_id TEXT'); } catch {}
// 群回收站查询: WHERE deleted_in_group_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC
try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notes_group_trash ON notes(deleted_in_group_id, deleted_at DESC) WHERE deleted_in_group_id IS NOT NULL'); } catch {}

// 群组待办子类型 (GROUP-TODO-DESIGN.md): todo_group_mode 'group'(群级,admin 控) / 'everyone'(每人完成); everyone 用 roster_due_at(截止) + roster_visibility(count/full)
try { sqlite.exec('ALTER TABLE notes ADD COLUMN todo_group_mode TEXT'); } catch {}
try { sqlite.exec('ALTER TABLE notes ADD COLUMN roster_due_at TEXT'); } catch {}
try { sqlite.exec('ALTER TABLE notes ADD COLUMN roster_visibility TEXT'); } catch {}
// 迁移: 现有已分享到群的待办默认归"群级待办"(group), 行为跟以前一样 (admin 控单一状态). 私有 / 未分享的不动 (留 NULL)
try { sqlite.exec("UPDATE notes SET todo_group_mode = 'group' WHERE type = 'todo' AND visibility = 'shared' AND todo_group_mode IS NULL"); } catch {}

// 通知中心. payload 默认 '{}' 跟 drizzle .default({}) 对齐, 老行 readAt 默认 NULL (= 未读).
// 两个 INDEX: 列通知按 (user, created_at DESC); 未读数走 partial index (sqlite 支持) 只索引未读行省空间
try { sqlite.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    category TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    payload TEXT DEFAULT '{}',
    read_at TEXT,
    created_at TEXT NOT NULL
  );
`); } catch {}
try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC)'); } catch {}
try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read_at) WHERE read_at IS NULL'); } catch {}

// 提醒分家 (个人提醒 + 群提醒 + 接收开关). 启动一次性迁移 notes.todo_due → note_personal_reminders.
// 旧 notes.todo_* 三列保留 (避免破坏老客户端读), 新版后端 scheduler 不再扫它们 (统一从两张提醒表扫).
// 复合主键 (user_id, note_id) / (note_id, group_id) / (user_id, group_id) 保证一对一
try { sqlite.exec(`
  CREATE TABLE IF NOT EXISTS note_personal_reminders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    note_id TEXT NOT NULL REFERENCES notes(id),
    due_at TEXT NOT NULL,
    rrule TEXT,
    remind_sent_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, note_id)
  );
`); } catch {}
// scheduler 扫 "due_at <= now AND remind_sent_at IS NULL" → partial index 节省扫描行数
try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_personal_reminders_due ON note_personal_reminders(due_at) WHERE remind_sent_at IS NULL'); } catch {}
// 给 NoteCard 拉某用户对某笔记的提醒用 (UNIQUE 索引自带支持, 不需额外)

try { sqlite.exec(`
  CREATE TABLE IF NOT EXISTS note_group_reminders (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id),
    group_id TEXT NOT NULL REFERENCES groups(id),
    due_at TEXT NOT NULL,
    rrule TEXT,
    remind_sent_at TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    UNIQUE (note_id, group_id)
  );
`); } catch {}
try { sqlite.exec('CREATE INDEX IF NOT EXISTS idx_group_reminders_due ON note_group_reminders(due_at) WHERE remind_sent_at IS NULL'); } catch {}

// group_reminder_subscriptions 表废. DROP 一次性清 (实际只控 group-reminder-set, 卡片级 mute 替代)
try { sqlite.exec('DROP TABLE IF EXISTS group_reminder_subscriptions'); } catch {}

// reminder_channels 加 types JSON 字段 (string[] 白名单, NULL=全收兼容老 row)
try { sqlite.exec('ALTER TABLE reminder_channels ADD COLUMN types TEXT'); } catch {}

// 笔记级群提醒 mute. 主键 (user_id, note_id), 跨所有群生效
try { sqlite.exec(`
  CREATE TABLE IF NOT EXISTS note_group_reminder_mutes (
    user_id TEXT NOT NULL REFERENCES users(id),
    note_id TEXT NOT NULL REFERENCES notes(id),
    muted_at TEXT NOT NULL,
    PRIMARY KEY (user_id, note_id)
  );
`); } catch {}

// 一次性迁移 (personal_reminder_migration_v1): notes.todo_due NOT NULL → note_personal_reminders 表.
// config flag 防重复跑 (反复跑会把已删的个人提醒又复活). 保持 deleted_at IS NULL 过滤
// (回收站待办的提醒迁不迁差别不大, 反正 scheduler 旧版也不发, 简化只迁 active)
try {
  const row = sqlite.prepare("SELECT value FROM config WHERE key = 'personal_reminder_migration_v1'").get() as { value: string } | undefined;
  if (!row) {
    // 全新空库在上面 legacy cleanup 已 DROP 掉 todo_due 列 (本就无数据可迁); 先检测列在不在,
    // 不在就跳过 SELECT, 避免 "no such column: todo_due" 报错 (首次启动空库必现; 老库迁过了 flag 在走不到这)
    const hasTodoDue = (sqlite.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>).some((c) => c.name === 'todo_due');
    const pending = hasTodoDue ? (sqlite.prepare(`SELECT id, user_id, todo_due, todo_remind_rrule, todo_remind_sent_at
      FROM notes WHERE todo_due IS NOT NULL AND deleted_at IS NULL`).all() as Array<{ id: string; user_id: string; todo_due: string; todo_remind_rrule: string | null; todo_remind_sent_at: string | null }>) : [];
    if (pending.length > 0) {
      const ins = sqlite.prepare(`INSERT OR IGNORE INTO note_personal_reminders (id, user_id, note_id, due_at, rrule, remind_sent_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const now = new Date().toISOString();
      const tx = sqlite.transaction((rows: typeof pending) => {
        for (const r of rows) ins.run(nanoid(12), r.user_id, r.id, r.todo_due, r.todo_remind_rrule, r.todo_remind_sent_at, now);
      });
      tx(pending);
      console.log(`[personal reminder migration v1] migrated ${pending.length} notes.todo_due → note_personal_reminders`);
    }
    sqlite.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run('personal_reminder_migration_v1', JSON.stringify(true));
  }
} catch (e) { console.error('[personal reminder migration v1] failed:', e); }
// 一次性回填 + 升级重算: PINYIN_SCHEMA_VERSION 每次 toPinyinSearchable 算法升级时 +1,
// 启动检测 config 表里存的版本号,低于当前版本就把所有 content_pinyin 清空让下面回填重算。
// v1: 全拼 + 单读音首字母. v2: 多音字首字母穷举. v3: 多音字只取前 2 读音. v4: 加罕用读音黑名单.
// v5: 弃用多音字穷举,只用 pinyin-pro 默认读音 —— 牺牲"重做"搜 cxcz 换全局零误命中
const PINYIN_SCHEMA_VERSION = 5;
try {
  const row = sqlite.prepare("SELECT value FROM config WHERE key = 'pinyin_schema_version'").get() as { value: string } | undefined;
  const curVer = row ? Number(JSON.parse(row.value)) : 0;
  if (curVer < PINYIN_SCHEMA_VERSION) {
    sqlite.prepare("UPDATE notes SET content_pinyin = NULL").run();
    console.log(`[pinyin migration] schema v${curVer} → v${PINYIN_SCHEMA_VERSION}, forcing full re-backfill`);
  }
  const pending = sqlite.prepare('SELECT id, content FROM notes WHERE content_pinyin IS NULL').all() as Array<{ id: string; content: string }>;
  if (pending.length > 0) {
    const upd = sqlite.prepare('UPDATE notes SET content_pinyin = ? WHERE id = ?');
    const tx = sqlite.transaction((rows: typeof pending) => {
      for (const r of rows) upd.run(toPinyinSearchable(r.content), r.id);
    });
    tx(pending);
    console.log(`[pinyin migration] backfilled ${pending.length} notes`);
  }
  sqlite.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('pinyin_schema_version', JSON.stringify(PINYIN_SCHEMA_VERSION));
} catch (e) { console.error('[pinyin migration] failed:', e); }

// 彻底删 categories.parent_id 列. 系统只支持一级分类, child 概念废弃
// SQLite 3.35+ 支持 DROP COLUMN, better-sqlite3 内置 SQLite 通常新版. 老版/已删则 catch 吞掉
try { sqlite.exec('ALTER TABLE categories DROP COLUMN parent_id'); } catch {}

// 一次性迁移 (avatar_relocate_migration_v1): 把老头像从 uploads/ 根目录搬到 uploads/avatars/ 子目录.
// 同步 users.avatar / groups.avatar URL 加 'avatars/' 前缀. 防越权下载 (中间件按 avatars/ 路径分支放行).
// 老格式: '/api/uploads/2026-05-30_HHmmss_avatar.png'
// 新格式: '/api/uploads/avatars/2026-05-30_HHmmss_avatar.png'
try {
  const row = sqlite.prepare("SELECT value FROM config WHERE key = 'avatar_relocate_migration_v1'").get() as { value: string } | undefined;
  if (!row) {
    const uploadsDir = UPLOAD_DIR;
    const avatarsDir = resolve(uploadsDir, 'avatars');
    if (!existsSync(uploadsDir)) {
      // uploads 目录都不存在 = 全新部署, 直接写 flag 跳过
      sqlite.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run('avatar_relocate_migration_v1', JSON.stringify(true));
    } else {
      if (!existsSync(avatarsDir)) mkdirSync(avatarsDir, { recursive: true });
      sqlite.transaction(() => {
        // 1. 扫根目录 buildUniqueFilename 用 'avatar' 作 safeName 的文件 (匹配 *_avatar.* 跟 *_avatar.*.thumb.jpg)
        let renamedCount = 0;
        try {
          const entries = readdirSync(uploadsDir, { withFileTypes: true });
          for (const ent of entries) {
            if (!ent.isFile()) continue;
            // 老 buildUniqueFilename 拼出来的 avatar 文件名格式: YYYY-MM-DD_HHmmss_avatar.{ext}
            // 含 thumb 衍生: YYYY-MM-DD_HHmmss_avatar.{ext}.thumb.jpg
            // 用宽松正则匹配: _avatar.{ext} 结尾 或 _avatar.{ext}.thumb.jpg 结尾
            if (!/_avatar\.[a-z]+(\.thumb\.jpg)?$/i.test(ent.name)) continue;
            try {
              renameSync(resolve(uploadsDir, ent.name), resolve(avatarsDir, ent.name));
              renamedCount++;
            } catch (e: any) {
              console.warn('[avatar migration v1] rename failed:', ent.name, e?.message);
            }
          }
        } catch (e: any) {
          console.warn('[avatar migration v1] scan uploads/ failed:', e?.message);
        }
        // 2. UPDATE users.avatar: '/api/uploads/X_avatar.Y' → '/api/uploads/avatars/X_avatar.Y'
        // 用 LIKE '_avatar.%' 匹配避免误伤已迁移过的 (含 'avatars/' 前缀)
        const usersUpd = sqlite.prepare(`
          UPDATE users SET avatar = REPLACE(avatar, '/api/uploads/', '/api/uploads/avatars/')
          WHERE avatar LIKE '/api/uploads/%_avatar.%'
            AND avatar NOT LIKE '/api/uploads/avatars/%'
        `).run();
        // 3. UPDATE groups.avatar 同款
        const groupsUpd = sqlite.prepare(`
          UPDATE groups SET avatar = REPLACE(avatar, '/api/uploads/', '/api/uploads/avatars/')
          WHERE avatar LIKE '/api/uploads/%_avatar.%'
            AND avatar NOT LIKE '/api/uploads/avatars/%'
        `).run();
        sqlite.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run('avatar_relocate_migration_v1', JSON.stringify(true));
        console.log(`[avatar migration v1] moved ${renamedCount} avatar files, updated ${usersUpd.changes} users + ${groupsUpd.changes} groups`);
      })();
    }
  }
} catch (e) { console.error('[avatar migration v1] failed:', e); }

export { schema };
