import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { resolve } from 'path';
import { toPinyinSearchable } from '../utils/pinyin.js';

const DB_PATH = process.env.QUINK_DB_PATH || resolve(process.cwd(), 'quink.db');

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
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    summary TEXT,
    category TEXT,
    tags TEXT DEFAULT '[]',
    type TEXT NOT NULL DEFAULT 'note',
    todo_status TEXT,
    todo_due TEXT,
    ai_processed INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    parent_id INTEGER,
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
// 一次性回填 + 升级重算: PINYIN_SCHEMA_VERSION 每次 toPinyinSearchable 算法升级时 +1,
// 启动检测 config 表里存的版本号,低于当前版本就把所有 content_pinyin 清空让下面回填重算。
// v1: 全拼 + 单读音首字母. v2: 多音字首字母穷举. v3: 多音字只取前 2 读音. v4: 加罕用读音黑名单.
// v5: 弃用多音字穷举,只用 pinyin-pro 默认读音 —— 牺牲"重做"搜 cxcz 换全局零误命中(蘑菇的决策)
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

export { schema };
