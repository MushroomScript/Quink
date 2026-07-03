import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, desc, like, or, and, sql, inArray, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import { authMiddleware } from '../auth.js';
import { autoTag, autoClassify, autoSummary, autoSimplify } from '../ai/client.js';
import { toPinyinSearchable } from '../utils/pinyin.js';
import { publish } from '../reminder/bus.js';
import { logAudit } from '../utils/auditLog.js';
import { createNotification, markRequestNotificationsRead } from '../utils/notifications.js';
import { purgeNote } from '../cleanup.js';
import { broadcastNoteShared } from '../utils/broadcast.js';

// 笔记 markdown 内容截 30 字符作为通知 title 后缀, 去 markdown 标记+换行. 太长前端 truncate
function noteSnippet(content: string, max = 30): string {
  const plain = content.replace(/[#*_`>\-\[\]!()]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > max ? plain.slice(0, max) + '…' : plain;
}

const app = new Hono();

// 所有笔记路由都需要登录
app.use('*', authMiddleware);

// content 上限 1MB (100 万字符约 2-3MB markdown 文件). 防恶意巨型笔记打爆 AI quota + DB.
// 超大 content 走"跳过 AI" 路径 (processNoteWithAi 内 plainTextLen > MAX 时不调 AI). 实际写入仍保留 (用户可能粘了真材实料的 1MB 文章)
const NOTE_CONTENT_MAX = 1_000_000;
const NOTE_AI_SKIP_THRESHOLD = 200_000; // 超过 200k 字符跳过 AI 处理防大账单

// strict 模式: 未知字段直接 400, 不静默 strip. 防老前端调 todoDue 等已删字段 200 静默忽略
const createNoteSchema = z.object({
  content: z.string().min(1).max(NOTE_CONTENT_MAX),
  type: z.enum(['quink', 'note', 'todo']).default('quink'),
  // null / undefined / 字符串都接受, 跟 updateNoteSchema 对称. null 跟 undefined 后端等价 (DB 默认 null).
  // refine 拒字符串 "未分类": 是系统保留名 (Sidebar/Stats 用它代表 category IS NULL), 防 API 直调写入让笔记"消失"在筛选里
  category: z.string().max(200).nullable().optional().refine((v) => v !== '未分类', { message: '"未分类" 是系统保留名, 笔记 category 字段不能设成此字符串 (用 null 表示未分类)' }),
  tags: z.array(z.string().max(50)).max(50).optional(),
  // todoDue / todoRemindRrule 已移除. 设提醒走 POST /:id/personal-reminder 单独接口
  // 群组共享: visibility=private (默认, 仅作者) / visibility=shared 必须给 sharedGroupIds[]
  visibility: z.enum(['private', 'shared']).default('private'),
  sharedGroupIds: z.array(z.string().max(32)).max(100).optional(),
  // 群组待办子类型 (GROUP-TODO-DESIGN.md): 仅 shared todo 有意义; 'everyone' 仅群管理员能设 (POST handler 校验)
  todoGroupMode: z.enum(['group', 'everyone']).optional(),
  rosterDueAt: z.string().nullable().optional(),
  rosterVisibility: z.enum(['count', 'full', 'none']).optional(),
  // float「AI整理」: true 时创建后后台 AI 精简 content 回填 (只对这条生效, 不污染普通新建笔记)
  simplifyContent: z.boolean().optional(),
}).strict();

const updateNoteSchema = z.object({
  content: z.string().min(1).max(NOTE_CONTENT_MAX).optional(),
  summary: z.string().max(2000).optional(),
  // null = 用户改回"自动" (清空 category 让后续 AI 可重新分类); undefined = 不动 category 字段; 字符串 = 手动选定.
  // refine 同 createNoteSchema 拒字符串 "未分类" (系统保留名)
  category: z.string().max(200).nullable().optional().refine((v) => v !== '未分类', { message: '"未分类" 是系统保留名, 笔记 category 字段不能设成此字符串 (用 null 表示未分类)' }),
  tags: z.array(z.string().max(50)).max(50).optional(),
  type: z.enum(['quink', 'note', 'todo']).optional(),
  todoStatus: z.enum(['pending', 'done']).optional(),
  // todoDue / todoRemindRrule 已移除. 设提醒走 personal-reminder 接口
  pinned: z.boolean().optional(),
  // 改可见性 / 重写分享群列表. sharedGroupIds 传值时整批替换 (delete all + insert new)
  visibility: z.enum(['private', 'shared']).optional(),
  sharedGroupIds: z.array(z.string()).optional(),
  // 编辑共享笔记必须带 lockToken (POST /lock 拿) + version (乐观锁). 私有笔记不需要.
  lockToken: z.string().optional(),
  version: z.number().int().positive().optional(),
  // 改编辑权限, 仅作者能改 (非作者传 → 403)
  editPermission: z.enum(['admin', 'all']).optional(),
  // COW: 改 shared 笔记时透传"从哪个上下文改" (前端按 router /groups/:gid 自动填).
  // 非作者改 → 必 fork 到 editContext.groupId 对应的群版本.
  // 作者改 + editContext.groupId 在 + 当前 note 是 root + 分享群数 > 1 → fork 到该群 (只影响该群).
  // 作者改 + 无 editContext.groupId → 直接改 root, 仍连的群都同步 (灵感页修改语义).
  editContext: z.object({
    groupId: z.string().optional(),
  }).optional(),
  // 任务清单 checkbox 等轻量 toggle 传 true → PATCH handler 跳过 updatedAt 刷新 (蘑菇 2026-06-29)
  skipTimestamp: z.boolean().optional(),
  // 群组待办子类型 (GROUP-TODO-DESIGN.md): 'everyone' 仅群管理员能改 (PATCH handler 校验)
  todoGroupMode: z.enum(['group', 'everyone']).optional(),
  rosterDueAt: z.string().nullable().optional(),
  rosterVisibility: z.enum(['count', 'full', 'none']).optional(),
}).strict();

// 广播 'group-notes-changed' 给目标群所有 active 成员 (除操作者).
// POST/PATCH 共享笔记 / 永久删除 共享笔记时调用, 前端在群详情页时自动 reload group feed
// originClientId: 调用方从 c.req.header('X-Quink-Client-Id') 拿, 透传给 publish 让发起方设备跳过自己发的事件 (其他用户和同账号其他设备的 clientId 不同, 正常处理)
// per-user per-group 1 次/秒去抖, 防 A 高频 PATCH 让群里 99 人客户端炸开 (每秒 990 API).
// 取舍: 同账号内连续 PATCH 后 SSE 合并到下一秒一次推送, 用户体验上"延迟 ≤1s" 但能挡住 DoS.
// in-memory map, 进程重启清空 (用单进程模式, 多 worker 部署改 Redis)
// broadcastNoteShared 抽到 utils/broadcast.ts, 这里只 import. 节流 + dedup 逻辑跟着挪.

// 校验所有 groupIds 都是 userId 的 active member 的群. 任一不符返回 error string, 全过返回 null
async function validateSharedGroups(userId: string, groupIds: string[]): Promise<string | null> {
  if (groupIds.length === 0) return null;
  const memberships = await db.select({ groupId: schema.groupMembers.groupId })
    .from(schema.groupMembers)
    .where(and(
      eq(schema.groupMembers.userId, userId),
      eq(schema.groupMembers.status, 'active'),
      inArray(schema.groupMembers.groupId, groupIds),
    )).all();
  const memberGroupIds = new Set(memberships.map(m => m.groupId));
  const notMember = groupIds.filter(id => !memberGroupIds.has(id));
  if (notMember.length > 0) return `不是这些群的成员: ${notMember.join(', ')}`;
  return null;
}

// GET /api/notes
app.get('/', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { search, category, type, tag, tags, types, dateFrom, dateTo, sort, scope = 'mine', page = '1', limit = '50' } = c.req.query();
  const offset = (parseInt(page) - 1) * parseInt(limit);
  // 排序字段: created (默认, 兼容老行为) / updated. 未知值兜底 createdAt 不报错.
  const sortColumn = sort === 'updated' ? schema.notes.updatedAt : schema.notes.createdAt;

  // scope 列表: private 笔记始终显示, sharedDisplay 偏好控制纳入哪些群组共享笔记.
  // mine (默认, 作者本人全部含 shared) / shared (仅他人共享给我, 兼容旧 API, 现偏好不再映射) / group:<id> (某群可见笔记)
  // 另外 3 个:
  //   private        = 仅作者本人 private (偏好 'none', 排除任何 shared)
  //   others_shared  = 作者本人 private + 他人共享给我所在群的 shared (偏好 'others', 排除我分享出去的 shared)
  //   all            = mine + 他人共享给我所在群的 shared (偏好 'all')
  const conditions: any[] = [
    sql`${schema.notes.deletedAt} IS NULL`, // 排除回收站
  ];
  if (scope === 'mine') {
    // 个人列表 (GROUP-TODO-DESIGN.md): 我的笔记 (但排除我发的"群级待办" group — 群级只在群组界面显示)
    // + 别人发的、我所在群的"每人完成待办" everyone (我需要各自完成, 混进我的列表; 靠下面 type filter 只在 Todos 露出)
    conditions.push(sql`(
      (${schema.notes.userId} = ${userId} AND (${schema.notes.todoGroupMode} IS NULL OR ${schema.notes.todoGroupMode} != 'group'))
      OR (${schema.notes.userId} != ${userId} AND ${schema.notes.type} = 'todo' AND ${schema.notes.todoGroupMode} = 'everyone'
          AND ${schema.notes.id} IN (
            SELECT ns.note_id FROM note_shares ns
            WHERE ns.group_id IN (SELECT group_id FROM group_members WHERE user_id = ${userId} AND status = 'active')
          ))
    )`);
  } else if (scope === 'private') {
    // 仅作者本人 private (任何 shared 都过滤). 对应 sharedDisplay='none'
    conditions.push(eq(schema.notes.userId, userId));
    conditions.push(eq(schema.notes.visibility, 'private'));
  } else if (scope === 'others_shared') {
    // 作者本人 private + 他人共享给我所在群的 shared (排除作者本人 shared). 对应 sharedDisplay='others'
    conditions.push(sql`(
      (${schema.notes.userId} = ${userId} AND ${schema.notes.visibility} = 'private')
      OR (${schema.notes.userId} != ${userId} AND ${schema.notes.id} IN (
        SELECT ns.note_id FROM note_shares ns
        WHERE ns.group_id IN (
          SELECT group_id FROM group_members WHERE user_id = ${userId} AND status = 'active'
        )
      ))
    )`);
  } else if (scope === 'shared') {
    // 遗留字段. 仅他人共享给我所在群的 shared (不含作者本人 private). sharedDisplay 不映射到此, 保留兼容旧调用方
    conditions.push(sql`${schema.notes.id} IN (
      SELECT ns.note_id FROM note_shares ns
      WHERE ns.group_id IN (
        SELECT group_id FROM group_members WHERE user_id = ${userId} AND status = 'active'
      )
    )`);
    conditions.push(sql`${schema.notes.userId} != ${userId}`);
  } else if (scope === 'all') {
    // mine ∪ 他人共享给我所在群的 shared. 对应 sharedDisplay='all'
    conditions.push(sql`(
      ${schema.notes.userId} = ${userId}
      OR ${schema.notes.id} IN (
        SELECT ns.note_id FROM note_shares ns
        WHERE ns.group_id IN (
          SELECT group_id FROM group_members WHERE user_id = ${userId} AND status = 'active'
        )
      )
    )`);
  } else if (scope.startsWith('group:')) {
    const groupId = scope.slice(6);
    // 校验我是该群 active member, 否则返回空 (不暴露非成员看群可见笔记)
    const me = await db.select().from(schema.groupMembers)
      .where(and(
        eq(schema.groupMembers.groupId, groupId),
        eq(schema.groupMembers.userId, userId),
        eq(schema.groupMembers.status, 'active'),
      )).get();
    if (!me) return c.json({ data: [], pagination: { page: parseInt(page), limit: parseInt(limit), total: 0 } });
    conditions.push(sql`${schema.notes.id} IN (SELECT note_id FROM note_shares WHERE group_id = ${groupId})`);
  } else {
    return c.json({ error: '无效的 scope, 应为 mine / private / others_shared / shared / all / group:<id>' }, 400);
  }

  if (search) {
    // 搜索内容、摘要、分类、标签 + 拼音(全拼/首字母,英文输入命中中文笔记)
    conditions.push(
      or(
        like(schema.notes.content, `%${search}%`),
        like(schema.notes.summary, `%${search}%`),
        like(schema.notes.category, `%${search}%`),
        sql`${schema.notes.tags} LIKE ${'%' + search + '%'}`,
        like(schema.notes.contentPinyin, `%${search.toLowerCase()}%`),
      )
    );
  }
  if (category === '__uncategorized__') {
    // sentinel: 前端 Sidebar "未分类" 虚拟项 / Stats "未分类" 饼图段点击传入, 走 IS NULL 筛 category 为空的笔记
    conditions.push(isNull(schema.notes.category));
  } else if (category) {
    // 之前用 like prefix 匹配 ("设计%" 会命中 "设计稿") 不是有意 → 改 eq 严格匹配分类名
    conditions.push(eq(schema.notes.category, category));
  }
  if (types) {
    const typeList = types.split(',').map(t => t.trim()).filter(Boolean);
    if (typeList.length > 0 && typeList.length < 4) {
      conditions.push(inArray(schema.notes.type, typeList as any));
    }
  } else if (type) {
    conditions.push(eq(schema.notes.type, type as any));
  }
  if (tag) {
    conditions.push(sql`${schema.notes.tags} LIKE ${'%"' + tag + '"%'}`);
  }
  if (tags) {
    for (const t of tags.split(',')) {
      const trimmed = t.trim();
      if (trimmed) conditions.push(sql`${schema.notes.tags} LIKE ${'%"' + trimmed + '"%'}`);
    }
  }
  if (dateFrom) {
    conditions.push(sql`${schema.notes.createdAt} >= ${dateFrom}`);
  }
  if (dateTo) {
    conditions.push(sql`${schema.notes.createdAt} <= ${dateTo + 'T23:59:59.999Z'}`);
  }

  const results = await db.select().from(schema.notes)
    .where(and(...conditions))
    .orderBy(desc(schema.notes.pinned), desc(sortColumn))
    .limit(parseInt(limit))
    .offset(offset);

  // 总数也带条件
  const countResult = db.select({ count: sql<number>`count(*)` })
    .from(schema.notes)
    .where(and(...conditions))
    .get();

  // 拼 sharedGroupIds (我的 shared 笔记 NoteCard 显示 "N 群" chip 用) +
  // scope!=mine 时拼 author info (NoteCard 显示作者头像区分"我的"vs"群里别人发的")
  let data: any[] = results;
  if (results.length > 0) {
    const noteIds = results.map(n => n.id);
    // 批量查 note_shares 聚合成 Map<noteId, groupIds[]>
    const sharesRows = await db.select({ noteId: schema.noteShares.noteId, groupId: schema.noteShares.groupId })
      .from(schema.noteShares)
      .where(inArray(schema.noteShares.noteId, noteIds))
      .all();
    const sharesMap = new Map<string, string[]>();
    for (const s of sharesRows) {
      const arr = sharesMap.get(s.noteId) || [];
      arr.push(s.groupId);
      sharesMap.set(s.noteId, arr);
    }
    // scope 含他人笔记时多查 author info. mine 现在也可能混入"别人发的 everyone 待办" → 用 results 是否含非自己笔记判断
    let authorMap: Map<string, { nickname: string; avatar: string | null }> | null = null;
    if (results.some(n => n.userId !== userId)) {
      const authorIds = [...new Set(results.map(n => n.userId))];
      const authors = await db.select({ id: schema.users.id, nickname: schema.users.nickname, avatar: schema.users.avatar })
        .from(schema.users)
        .where(inArray(schema.users.id, authorIds))
        .all();
      authorMap = new Map(authors.map(u => [u.id, { nickname: u.nickname, avatar: u.avatar }]));
    }
    // 给 shared 笔记拼 reaction summary + comment count (NoteCard 底部显示). private 笔记跳过.
    // 给 shared 笔记拼 editorCount (NoteCard 显示"X 人编辑过", 仅算非作者编辑次数, 作者自己改不计).
    // 给 shared 笔记拼 canWrite (NoteCard 预判"点编辑能否进 modal", 没权限直接弹申请对话框).
    const sharedNotes = results.filter(n => n.visibility === 'shared');
    const sharedNoteIds = sharedNotes.map(n => n.id);
    const sharedForCanWrite = sharedNotes.map(n => ({
      id: n.id, userId: n.userId, editPermission: n.editPermission,
      sharedGroupIds: sharesMap.get(n.id) || [],
    }));
    // 每人完成待办: 批量查完成聚合 (completed/total/mine)
    const everyoneNoteIds = results.filter(n => n.type === 'todo' && n.todoGroupMode === 'everyone').map(n => n.id);
    const [{ reactionMap, commentCountMap }, editorCountMap, canWriteMap, todoDoneMap] = await Promise.all([
      loadSocialMetaMaps(sharedNoteIds, userId),
      loadEditorCountMap(sharedNoteIds),
      loadCanWriteMap(sharedForCanWrite, userId),
      loadTodoDoneMaps(everyoneNoteIds, userId),
    ]);
    data = results.map(n => {
      const enriched: any = { ...n, sharedGroupIds: sharesMap.get(n.id) || [] };
      if (authorMap) {
        const a = authorMap.get(n.userId);
        enriched.authorNickname = a?.nickname ?? null;
        enriched.authorAvatar = a?.avatar ?? null;
      }
      if (n.visibility === 'shared') {
        enriched.reactionSummary = reactionMap.get(n.id) || ALLOWED_REACTION_EMOJIS.map(e => ({ emoji: e, count: 0, mine: false }));
        enriched.commentCount = commentCountMap.get(n.id) || 0;
        enriched.editorCount = editorCountMap.get(n.id) || 0;
        enriched.canWrite = canWriteMap.get(n.id) ?? false;
      }
      // 每人完成待办: 加完成聚合 + groupDone (运行时算: 全员完成 OR 超截止)
      if (n.type === 'todo' && n.todoGroupMode === 'everyone') {
        const s = todoDoneMap.get(n.id) || { completed: 0, total: 0, mine: false };
        const overdue = !!n.rosterDueAt && dayjs().isAfter(dayjs(n.rosterDueAt));
        // 个人列表: none 可见性 → 隐藏进度 (只留完成勾). 个人列表不显示名单, admin 想看完整去详情/群界面
        enriched.todoDoneSummary = { ...s, groupDone: (s.total > 0 && s.completed >= s.total) || overdue, hideProgress: n.rosterVisibility === 'none' };
      }
      return enriched;
    });
  }

  return c.json({
    data,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: countResult?.count ?? 0,
    },
  });
});

// ── 回收站（必须在 /:id 之前注册）──

// GET /api/notes/trash
app.get('/trash', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  // 个人回收站: 作者自己的所有软删 root 笔记 (fork 不进回收站, fork 是某群独占副本不属于作者主视图概念)
  // deletedInGroupId IS NULL 排除群回收站项 (admin 删别人共享笔记走群回收站, 不进作者个人 trash)
  // 之前加 "NOT EXISTS active fork" 排除了 root 孤儿场景 (root 最后一份 share 被 fork 走时 root
  // 被孤儿处理软删 + visibility=private, 但同时有 fork active → 永远不在作者回收站, 作者找不回原版). 去掉这个条件让孤儿能恢复.
  // 恢复后 root 仍 private, 不撞群里 fork (fork 在群里继续 active 不变)
  const results = await db.select().from(schema.notes)
    .where(and(
      eq(schema.notes.userId, userId),
      sql`${schema.notes.deletedAt} IS NOT NULL`,
      sql`${schema.notes.parentNoteId} IS NULL`,
      sql`${schema.notes.deletedInGroupId} IS NULL`,
    ))
    .orderBy(desc(schema.notes.deletedAt))
    .all();
  // 拼 sharedGroupIds 让 Trash 删除确认窗显示 "已分享到 N 群组"
  if (results.length === 0) return c.json({ data: results });
  const noteIds = results.map(n => n.id);
  const sharesRows = await db.select({ noteId: schema.noteShares.noteId, groupId: schema.noteShares.groupId })
    .from(schema.noteShares)
    .where(inArray(schema.noteShares.noteId, noteIds))
    .all();
  const sharesMap = new Map<string, string[]>();
  for (const s of sharesRows) {
    const arr = sharesMap.get(s.noteId) || [];
    arr.push(s.groupId);
    sharesMap.set(s.noteId, arr);
  }
  const data = results.map(n => ({ ...n, sharedGroupIds: sharesMap.get(n.id) || [] }));
  return c.json({ data });
});

// POST /api/notes/trash/:id/restore
app.post('/trash/:id/restore', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  const existing = await db.select().from(schema.notes)
    .where(and(eq(schema.notes.id, id), eq(schema.notes.userId, userId))).get();
  if (!existing || !existing.deletedAt) return c.json({ error: '笔记不存在' }, 404);
  await db.update(schema.notes).set({ deletedAt: null }).where(eq(schema.notes.id, id));
  // 多设备 / 群成员同步: restore 后笔记从 trash 回到主 view, 语义等价"新出现一条笔记" → 复用 note-created 让前端拉单条插入
  publish(userId, 'note-created', { noteId: id }, _ocid);
  if (existing.visibility === 'shared') {
    const shares = await db.select({ groupId: schema.noteShares.groupId })
      .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).all();
    if (shares.length > 0) {
      broadcastNoteShared(shares.map(s => s.groupId), userId, _ocid).catch(e => console.error('[notes] restore broadcast failed:', e));
    }
  }
  await logAudit(c, 'note.restore', 'note', id, { visibility: existing.visibility });
  return c.json({ message: '已恢复' });
});

// DELETE /api/notes/trash/:id
app.delete('/trash/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  // 拿 sharedGroupIds 在删除前 (删完 note_shares 就没了)
  const existing = await db.select().from(schema.notes)
    .where(and(eq(schema.notes.id, id), eq(schema.notes.userId, userId))).get();
  const shareGroupIds = existing?.visibility === 'shared'
    ? (await db.select({ groupId: schema.noteShares.groupId })
        .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).all()).map(s => s.groupId)
    : [];
  // purgeNote 走完整 cascade (清 9 张子表 + notes), 修原只清 noteShares/groupNotePins 漏 noteEditGrants / notePersonalReminders 等 FK
  if (existing) purgeNote(id);
  // 多设备 + 群成员同步: 作者其他设备的回收站列表移除该 id; 群成员 feed 也确认彻底清
  publish(userId, 'note-deleted', { noteId: id }, _ocid);
  if (shareGroupIds.length > 0) {
    broadcastNoteShared(shareGroupIds, userId, _ocid).catch(e => console.error('[notes] permanent delete broadcast failed:', e));
  }
  await logAudit(c, 'note.permanent_delete', 'note', id, { sharedGroupIds: shareGroupIds });
  return c.json({ message: '已永久删除' });
});

// DELETE /api/notes/trash — 清空
app.delete('/trash', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  // 先拿要删的 noteIds 清 note_shares, 再删 notes (单 DELETE 包 subquery 也能但事务更清晰)
  const trashed = await db.select({ id: schema.notes.id }).from(schema.notes)
    .where(and(eq(schema.notes.userId, userId), sql`${schema.notes.deletedAt} IS NOT NULL`))
    .all();
  if (trashed.length === 0) return c.json({ message: '已清空' });
  const ids = trashed.map(t => t.id);
  // 走完整 cascade purgeNote (修原只清 noteShares/groupNotePins 漏其他 FK 子表)
  for (const tid of ids) purgeNote(tid);
  // 多设备同步: 作者本人所有设备清空回收站界面 + 主 view cache 标 dirty
  publish(userId, 'trash-cleared', { count: ids.length }, _ocid);
  await logAudit(c, 'note.permanent_delete_all_trash', 'note', null, { count: ids.length });
  return c.json({ message: '已清空' });
});

// GET /api/notes/tags（必须在 /:id 之前注册）
app.get('/tags', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const notes = await db.select({ tags: schema.notes.tags })
    .from(schema.notes).where(and(eq(schema.notes.userId, userId), sql`${schema.notes.deletedAt} IS NULL`)).all();
  const tagSet = new Set<string>();
  for (const n of notes) {
    const t = (n.tags as string[]) || [];
    t.forEach(tag => tagSet.add(tag));
  }
  // Intl.Collator 用 CLDR 中文 locale 按拼音排:'啊' < '吧' < '从' (a < b < c),
  // 中英数字混排时数字/英文也按本地化规则插入 (而非纯 UTF-16 字典序)
  return c.json({ data: [...tagSet].sort(new Intl.Collator('zh-Hans-CN').compare) });
});

// helper: 校验 userId 能否访问 noteId. 作者本人永远放行; 否则必须 visibility='shared' + 我是 note_shares 关联群 active member.
// mode='read' (默认) 只校验可见; mode='write' 加 editPermission 校验:
//   editPermission='all' → 所有 active member 都能改
//   editPermission='admin' → 必须我在共享群里是 owner/admin
//   都不满足 → 查 note_edit_grants 白名单, 在内则放行 (申请编辑权通过后写入)
// 返回 note 或 null. lock API + PATCH + DELETE + chat update_note 都用这函数.
type AccessMode = 'read' | 'write';
async function getNoteForAccess(userId: string, noteId: string, mode: AccessMode = 'read'): Promise<typeof schema.notes.$inferSelect | null> {
  const note = await db.select().from(schema.notes).where(eq(schema.notes.id, noteId)).get();
  if (!note) return null;
  // 软删笔记不能被任何操作访问 (duplicate / lock / PATCH / reaction / comment).
  // 作者要恢复请用 /trash/:id/restore. 防被害者删除后他人仍能复制走 (隐私残留)
  if (note.deletedAt) return null;
  // 作者本人无视所有限制 (read + write)
  if (note.userId === userId) return note;
  // 不是作者: 必须 shared 笔记
  if (note.visibility !== 'shared') return null;
  // 必须我是某共享群 active member (read 走到这一步就够了)
  const shared = await db.select({ groupId: schema.noteShares.groupId })
    .from(schema.noteShares).where(eq(schema.noteShares.noteId, noteId)).all();
  if (shared.length === 0) return null;
  const myMemberships = await db.select({ groupId: schema.groupMembers.groupId, role: schema.groupMembers.role })
    .from(schema.groupMembers)
    .where(and(
      eq(schema.groupMembers.userId, userId),
      eq(schema.groupMembers.status, 'active'),
      inArray(schema.groupMembers.groupId, shared.map(s => s.groupId)),
    )).all();
  if (myMemberships.length === 0) return null;
  if (mode === 'read') return note;
  // write 模式: editPermission 三档校验
  if (note.editPermission === 'all') return note;
  // editPermission='admin': 在任一共享群是 owner/admin 即可
  if (myMemberships.some(m => m.role === 'owner' || m.role === 'admin')) return note;
  // 都不满足 → 查白名单 (note_edit_grants 申请通过后永久授权)
  const grant = await db.select({ noteId: schema.noteEditGrants.noteId })
    .from(schema.noteEditGrants)
    .where(and(
      eq(schema.noteEditGrants.noteId, noteId),
      eq(schema.noteEditGrants.userId, userId),
    )).get();
  return grant ? note : null;
}

// COW 分叉: shared 笔记被非作者改 / 作者从群组页改"还连多群的 root note" 时调用.
// 必须在 db.transaction((tx) => ...) 内同步执行. 同步执行: 新建 fork note row (复制 root 内容, parentNoteId 指 root,
// 清锁, version=1), 转移该群的 note_shares + group_note_pins (从 original 转给 newId), 复制 note_edit_grants 让
// 作者授权延续到 fork. reactions / comments 不跟随 fork (约定: 表态属于原内容, 仍留 original).
// 单层链: parentNoteId 永远指 root note, 不嵌套 fork-of-fork. 若 original 已是 fork (parentNoteId 非空), 新 fork
// 仍指向 original.parentNoteId. 返回新 fork 的 note id, 调用方在 tx 内继续 apply updates 到 new row.
function forkNote(
  tx: any,
  original: typeof schema.notes.$inferSelect,
  groupId: string,
  now: string,
): string {
  const newId = nanoid(12);
  const rootId = original.parentNoteId ?? original.id;
  tx.insert(schema.notes).values({
    id: newId,
    userId: original.userId, // COW 关键: 原作者归属保留, fork 后 userId 不变
    content: original.content,
    contentPinyin: original.contentPinyin,
    summary: original.summary,
    category: original.category,
    tags: original.tags as any,
    type: original.type,
    todoStatus: original.todoStatus,
    aiProcessed: original.aiProcessed,
    pinned: original.pinned,
    createdAt: original.createdAt, // fork 不是"新建", 沿用 root 创建时间 (按创建时间排序时新老版本挨在一起)
    updatedAt: now,
    deletedAt: null,
    visibility: 'shared', // fork 出来必然是 shared (fork 触发条件就要求 shared)
    editLockBy: null,
    editLockToken: null,
    editLockExpiresAt: null,
    version: 1,
    editPermission: original.editPermission,
    parentNoteId: rootId,
  }).run();
  // 该群的 note_shares 从 original 转到 newId. 其它群仍指 original (除非也被 fork).
  tx.delete(schema.noteShares).where(and(
    eq(schema.noteShares.noteId, original.id),
    eq(schema.noteShares.groupId, groupId),
  )).run();
  tx.insert(schema.noteShares).values({
    noteId: newId,
    groupId,
    sharedAt: now,
  }).run();
  // group_note_pins 跟随: 该群该笔记的置顶迁到 fork (否则置顶视觉断)
  const pin = tx.select().from(schema.groupNotePins).where(and(
    eq(schema.groupNotePins.groupId, groupId),
    eq(schema.groupNotePins.noteId, original.id),
  )).get();
  if (pin) {
    tx.delete(schema.groupNotePins).where(and(
      eq(schema.groupNotePins.groupId, groupId),
      eq(schema.groupNotePins.noteId, original.id),
    )).run();
    tx.insert(schema.groupNotePins).values({
      groupId,
      noteId: newId,
      pinnedBy: pin.pinnedBy,
      pinnedAt: pin.pinnedAt,
    }).run();
  }
  // note_edit_grants 复制: 作者授权过的人在 fork 上也保留权限 (尊重作者意图)
  const grants = tx.select().from(schema.noteEditGrants).where(
    eq(schema.noteEditGrants.noteId, original.id),
  ).all();
  for (const g of grants) {
    tx.insert(schema.noteEditGrants).values({
      noteId: newId,
      userId: g.userId,
      grantedAt: g.grantedAt,
      grantedBy: g.grantedBy,
    }).run();
  }
  return newId;
}

// 批量算一组 shared 笔记的 canWrite. 前端 NoteCard 用来预判"点编辑是 openModal 还是弹申请对话框",
// 避免没权限的用户进 modal 闪一下后才弹申请窗 (NoteEditModal acquireLock 失败兜底仍保留, 防权限中途被撤罕见 case).
// 参数 sharedNotes 必须已含 sharedGroupIds (调用方 enrich 阶段批量查过 note_shares 后传入).
// canWrite = isAuthor || editPermission='all' || 我在任一共享群是 owner/admin || 我在 grants 白名单
export async function loadCanWriteMap(
  sharedNotes: Array<{ id: string; userId: string; editPermission: string | null; sharedGroupIds: string[] }>,
  userId: string,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (sharedNotes.length === 0) return out;
  // 收集所有共享群 ID, 查我在这些群里的 active 角色
  const allGroupIds = new Set<string>();
  for (const n of sharedNotes) for (const gid of n.sharedGroupIds) allGroupIds.add(gid);
  let adminGroups = new Set<string>();
  if (allGroupIds.size > 0) {
    const myMemberships = await db.select({ groupId: schema.groupMembers.groupId, role: schema.groupMembers.role })
      .from(schema.groupMembers)
      .where(and(
        eq(schema.groupMembers.userId, userId),
        eq(schema.groupMembers.status, 'active'),
        inArray(schema.groupMembers.groupId, [...allGroupIds]),
      )).all();
    adminGroups = new Set(myMemberships.filter(m => m.role === 'owner' || m.role === 'admin').map(m => m.groupId));
  }
  // 批量查我在这些笔记上的 grants
  const grants = await db.select({ noteId: schema.noteEditGrants.noteId })
    .from(schema.noteEditGrants)
    .where(and(
      eq(schema.noteEditGrants.userId, userId),
      inArray(schema.noteEditGrants.noteId, sharedNotes.map(n => n.id)),
    )).all();
  const grantedNoteIds = new Set(grants.map(g => g.noteId));
  for (const n of sharedNotes) {
    if (n.userId === userId) { out.set(n.id, true); continue; }
    if (n.editPermission === 'all') { out.set(n.id, true); continue; }
    if (n.sharedGroupIds.some(gid => adminGroups.has(gid))) { out.set(n.id, true); continue; }
    out.set(n.id, grantedNoteIds.has(n.id));
  }
  return out;
}

// 批量拉一组笔记的 distinct editor count (不含作者本人, 作者改不写 history).
// NoteCard 显示"X 人编辑过"用. shared 笔记才查 (private 笔记不会有 history 记录).
export async function loadEditorCountMap(noteIds: string[]): Promise<Map<string, number>> {
  if (noteIds.length === 0) return new Map();
  const rows = await db.select({
    noteId: schema.noteEditHistory.noteId,
    userId: schema.noteEditHistory.userId,
  }).from(schema.noteEditHistory)
    .where(inArray(schema.noteEditHistory.noteId, noteIds))
    .all();
  const perNote = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = perNote.get(r.noteId);
    if (!s) { s = new Set(); perNote.set(r.noteId, s); }
    s.add(r.userId);
  }
  const out = new Map<string, number>();
  for (const [nid, set] of perNote) out.set(nid, set.size);
  return out;
}

// helper: 校验 userId 在指定群里是否 owner/admin (按 groupId 直接查, 给"创建每人完成待办"等笔记还没存的场景用)
async function isAdminOfGroups(userId: string, groupIds: string[]): Promise<boolean> {
  if (groupIds.length === 0) return false;
  const myAdmin = await db.select({ role: schema.groupMembers.role })
    .from(schema.groupMembers)
    .where(and(
      eq(schema.groupMembers.userId, userId),
      eq(schema.groupMembers.status, 'active'),
      inArray(schema.groupMembers.groupId, groupIds),
      or(eq(schema.groupMembers.role, 'owner'), eq(schema.groupMembers.role, 'admin')),
    )).get();
  return !!myAdmin;
}

// helper: 校验 userId 在某 shared 笔记关联的群里是 owner/admin. 给 DELETE / 审批申请等
// "管理操作"用 (普通成员有 write 权限也不应能删 / 批申请). 笔记不存在 / 不是 shared / 无 admin 角色 → false
async function isAdminOfSharedNote(userId: string, noteId: string): Promise<boolean> {
  const shared = await db.select({ groupId: schema.noteShares.groupId })
    .from(schema.noteShares).where(eq(schema.noteShares.noteId, noteId)).all();
  if (shared.length === 0) return false;
  const myAdmin = await db.select({ role: schema.groupMembers.role })
    .from(schema.groupMembers)
    .where(and(
      eq(schema.groupMembers.userId, userId),
      eq(schema.groupMembers.status, 'active'),
      inArray(schema.groupMembers.groupId, shared.map(s => s.groupId)),
      or(eq(schema.groupMembers.role, 'owner'), eq(schema.groupMembers.role, 'admin')),
    )).get();
  return !!myAdmin;
}

// 编辑锁: 5 分钟 TTL + 30s 前端心跳续约 + sendBeacon 离开释放 + cron 60s 兜底清过期.
// 仅 shared 笔记走锁逻辑 (private 笔记不需协作, lock API 调用会 400).
const LOCK_TTL_MS = 5 * 60 * 1000;

// 表情 reaction 固定 5 个白名单 (前端 ReactionBar 同一份). 防极端搞怪 / 垃圾数据 / 兼容性差的 emoji.
const ALLOWED_REACTION_EMOJIS = ['👍', '❤️', '🤔', '✅', '😂'] as const;
type AllowedReactionEmoji = typeof ALLOWED_REACTION_EMOJIS[number];

// 评论长度上限 (字符数, 中文也算 1). 防灌水 / 过长评论撑爆界面.
const COMMENT_MAX_LEN = 1000;

// POST /api/notes/:id/lock — 申请编辑锁. 别人持锁未过期 → 409 带 lockByNickname + expiresAt
app.post('/:id/lock', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  // 用 read mode 校验 - 没编辑权连锁都拿不到, 避免编辑到一半提交才发现没权 (体验差)
  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  if (note.visibility !== 'shared') return c.json({ error: 'private 笔记不需要编辑锁' }, 400);
  if (note.userId !== userId) {
    const writable = await getNoteForAccess(userId, id, 'write');
    if (!writable) {
      return c.json({
        error: 'no_write_permission',
        editPermission: note.editPermission,
      }, 403);
    }
  }

  const now = dayjs();
  const expired = !note.editLockExpiresAt || dayjs(note.editLockExpiresAt).isBefore(now);
  if (note.editLockBy && !expired && note.editLockBy !== userId) {
    const lockUser = await db.select({ nickname: schema.users.nickname })
      .from(schema.users).where(eq(schema.users.id, note.editLockBy)).get();
    return c.json({
      error: 'locked',
      lockByNickname: lockUser?.nickname || '其他用户',
      expiresAt: note.editLockExpiresAt,
    }, 409);
  }

  // 我自己续锁 / 拿空闲锁 / 抢过期锁 都重发 token + expires_at (旧 token 自动失效, 防同用户多设备脏写)
  const token = nanoid(16);
  const expiresAt = now.add(LOCK_TTL_MS, 'ms').toISOString();
  await db.update(schema.notes).set({
    editLockBy: userId,
    editLockToken: token,
    editLockExpiresAt: expiresAt,
  }).where(eq(schema.notes.id, id));
  return c.json({ data: { lockToken: token, expiresAt } });
});

// POST /api/notes/:id/lock/heartbeat — 续约 (前端 setInterval 30s 调)
app.post('/:id/lock/heartbeat', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const lockToken = body?.lockToken;
  if (!lockToken) return c.json({ error: '缺少 lockToken' }, 400);

  const note = await getNoteForAccess(userId, id);
  if (!note) return c.json({ error: '笔记不存在' }, 404);

  if (note.editLockBy !== userId || note.editLockToken !== lockToken) {
    return c.json({ error: 'lock_invalid' }, 409);
  }
  const now = dayjs();
  if (note.editLockExpiresAt && dayjs(note.editLockExpiresAt).isBefore(now)) {
    return c.json({ error: 'lock_expired' }, 409);
  }

  // 续约时复核 write 权. 防"用户 X 拿 grant → 申锁 → 作者撤 grant → X 持锁续约阻塞别人 5min" DoS.
  // 作者本人始终通过 (write 校验里 author 直接放行); editPermission='all' 也通过; 仅 grant 被撤的情况会拒
  if (note.userId !== userId) {
    const writable = await getNoteForAccess(userId, id, 'write');
    if (!writable) {
      // 主动清掉这把过期权限的锁让别人能拿
      await db.update(schema.notes).set({
        editLockBy: null, editLockToken: null, editLockExpiresAt: null,
      }).where(eq(schema.notes.id, id));
      return c.json({ error: 'no_write_permission' }, 403);
    }
  }

  const expiresAt = now.add(LOCK_TTL_MS, 'ms').toISOString();
  await db.update(schema.notes).set({ editLockExpiresAt: expiresAt })
    .where(eq(schema.notes.id, id));
  return c.json({ data: { expiresAt } });
});

// DELETE /api/notes/:id/lock — 释放 (前端 onBeforeUnmount + sendBeacon 调). sendBeacon 无 body 也兼容, 看 lock_by 是否我.
app.delete('/:id/lock', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  const note = await getNoteForAccess(userId, id);
  if (!note) return c.json({ error: '笔记不存在' }, 404);

  // sendBeacon 不带 body 是常态, 容错: 只看 lock_by == me 就放行清锁 (跟别人没关, 别人持锁我也不会调 release)
  if (note.editLockBy !== userId) return c.json({ data: { released: false } });

  await db.update(schema.notes).set({
    editLockBy: null,
    editLockToken: null,
    editLockExpiresAt: null,
  }).where(eq(schema.notes.id, id));
  return c.json({ data: { released: true } });
});

// cron: 60s 扫一次清过期锁. 兜底 case: 用户没 sendBeacon (浏览器异常关 / 断电), 锁自然过期但 lock_by 留着.
// scheduler.ts 同款 setInterval 模式, 启动一次, tsx 进程重启自然重新计时.
export function startEditLockCleanup() {
  setInterval(async () => {
    try {
      const now = dayjs().toISOString();
      await db.update(schema.notes).set({
        editLockBy: null,
        editLockToken: null,
        editLockExpiresAt: null,
      }).where(and(
        sql`${schema.notes.editLockBy} IS NOT NULL`,
        sql`${schema.notes.editLockExpiresAt} < ${now}`,
      ));
    } catch (e) {
      console.error('[edit-lock cleanup] failed:', e);
    }
  }, 60 * 1000);
  console.log('[edit-lock cleanup] started, 60s interval');
}

// helper: 给某笔记的"权限审批 / SSE 通知"收件人 = 作者 + 所有共享群的 owner/admin user ids (dedup)
async function getNoteAuthorityRecipients(noteId: string): Promise<string[]> {
  const note = await db.select({ userId: schema.notes.userId }).from(schema.notes)
    .where(eq(schema.notes.id, noteId)).get();
  if (!note) return [];
  const shared = await db.select({ groupId: schema.noteShares.groupId })
    .from(schema.noteShares).where(eq(schema.noteShares.noteId, noteId)).all();
  if (shared.length === 0) return [note.userId];
  const admins = await db.select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(and(
      inArray(schema.groupMembers.groupId, shared.map(s => s.groupId)),
      eq(schema.groupMembers.status, 'active'),
      or(eq(schema.groupMembers.role, 'owner'), eq(schema.groupMembers.role, 'admin')),
    )).all();
  return [...new Set([note.userId, ...admins.map(a => a.userId)])];
}

// 编辑权限申请 API (5 个): 申请 / 同意 / 拒绝 / 列待审申请 / 撤销已授权
// 改 editPermission 走 PATCH /:id 的 editPermission 字段, 不另外加 API. 跟 visibility / sharedGroupIds 同款约定 (仅作者改).

// edit-request rejected 后冷却 24h, 防"循环 rejected 重申请" spam SSE 给作者
const EDIT_REQUEST_REJECT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// 评论 + 申请 message 简单 markdown sanitize. 后端深度防御 (前端 Vditor 也会渲染时过滤).
// 拦截 javascript: / data: / vbscript: 等危险 URI scheme, 含在 markdown link href 里
function sanitizeUserMarkdown(text: string): string {
  if (!text) return text;
  // markdown link / image: [label](url) ![alt](url)
  return text.replace(/(\!?\[[^\]]*\])\(([^)]+)\)/g, (full, label, url) => {
    const trimmed = String(url).trim().toLowerCase();
    if (trimmed.startsWith('javascript:') || trimmed.startsWith('vbscript:') ||
        (trimmed.startsWith('data:') && !trimmed.startsWith('data:image/'))) {
      return `${label}(#blocked)`;
    }
    return full;
  });
}

// POST /api/notes/:id/edit-request - 申请编辑权 (没 write 权的群成员调). 已 pending 返原 request (idempotent).
app.post('/:id/edit-request', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({} as any));
  const message: string | null = typeof body?.message === 'string' ? body.message.slice(0, 500) : null;

  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  if (note.visibility !== 'shared') return c.json({ error: '私有笔记不支持申请编辑权限' }, 400);
  if (note.userId === userId) return c.json({ error: '你是作者, 不需要申请' }, 400);
  // 已有 write 权限的不应该再申请 (前端按钮也不该显示, 这里兜底)
  const writable = await getNoteForAccess(userId, id, 'write');
  if (writable) return c.json({ error: '你已有编辑权限, 不需要申请' }, 400);

  const existing = await db.select().from(schema.noteEditRequests)
    .where(and(
      eq(schema.noteEditRequests.noteId, id),
      eq(schema.noteEditRequests.userId, userId),
      eq(schema.noteEditRequests.status, 'pending'),
    )).get();
  if (existing) return c.json({ data: existing });

  // rejected 后 24h 冷却防 spam
  const recentRejected = await db.select().from(schema.noteEditRequests)
    .where(and(
      eq(schema.noteEditRequests.noteId, id),
      eq(schema.noteEditRequests.userId, userId),
      eq(schema.noteEditRequests.status, 'rejected'),
    )).orderBy(desc(schema.noteEditRequests.handledAt)).get();
  if (recentRejected?.handledAt) {
    const cooldownEnd = dayjs(recentRejected.handledAt).add(EDIT_REQUEST_REJECT_COOLDOWN_MS, 'ms');
    if (cooldownEnd.isAfter(dayjs())) {
      return c.json({
        error: 'request_in_cooldown',
        message: '上次申请被拒绝, 请 24 小时后再申请',
        retryAfter: cooldownEnd.toISOString(),
      }, 429);
    }
  }

  const reqId = nanoid(12);
  const now = dayjs().toISOString();
  // sanitize 申请 message 防恶意 markdown 注入 (SSE payload 透传给作者前端渲染)
  const sanitizedMessage = message ? sanitizeUserMarkdown(message) : null;
  const newReq: schema.NewNoteEditRequest = {
    id: reqId, noteId: id, userId, status: 'pending', message: sanitizedMessage,
    createdAt: now, handledAt: null, handledBy: null,
  };
  await db.insert(schema.noteEditRequests).values(newReq);

  // SSE 推作者 + 群 admin (除申请人自己). 透传 _ocid 让同账号其他设备跳过
  const requester = await db.select({ nickname: schema.users.nickname })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  const recipients = await getNoteAuthorityRecipients(id);
  const snippet = noteSnippet(note.content);
  for (const rid of recipients) {
    if (rid === userId) continue;
    publish(rid, 'note-edit-request', {
      requestId: reqId, noteId: id, noteUserId: note.userId,
      requesterId: userId, requesterNickname: requester?.nickname || '群成员', message: sanitizedMessage,
    }, _ocid);
    // 写入通知中心. body 跟 toast 文案对齐, payload 含 noteId 让 view 点击跳详情
    createNotification(rid, 'content', 'edit-request',
      `${requester?.nickname || '群成员'} 申请编辑你的笔记`,
      sanitizedMessage ? `${snippet}: ${sanitizedMessage}` : snippet,
      { noteId: id, requestId: reqId, fromUserId: userId },
    ).catch(() => {});
  }
  await logAudit(c, 'note.edit_request', 'note', id, { requestId: reqId });
  return c.json({ data: newReq }, 201);
});

// POST /api/notes/:id/edit-requests/:reqId/approve - 同意 (作者+群 admin), 永久授权 (写 note_edit_grants)
app.post('/:id/edit-requests/:reqId/approve', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id, reqId } = c.req.param();

  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  const isAuthor = note.userId === userId;
  if (!isAuthor && !(await isAdminOfSharedNote(userId, id))) {
    return c.json({ error: '只有作者或群管理员可以审批' }, 403);
  }
  const req = await db.select().from(schema.noteEditRequests)
    .where(and(eq(schema.noteEditRequests.id, reqId), eq(schema.noteEditRequests.noteId, id))).get();
  if (!req) return c.json({ error: '申请不存在' }, 404);
  if (req.status !== 'pending') return c.json({ error: '该申请已处理' }, 400);

  const now = dayjs().toISOString();
  db.transaction((tx) => {
    tx.update(schema.noteEditRequests).set({
      status: 'approved', handledAt: now, handledBy: userId,
    }).where(eq(schema.noteEditRequests.id, reqId)).run();
    // INSERT OR IGNORE 防重复 (PRIMARY KEY note_id+user_id 已存在则静默)
    tx.insert(schema.noteEditGrants).values({
      noteId: id, userId: req.userId, grantedAt: now, grantedBy: userId,
    }).onConflictDoNothing().run();
  });

  publish(req.userId, 'note-edit-request-resolved', {
    requestId: reqId, noteId: id, status: 'approved', handledBy: userId,
  }, _ocid);
  // 写通知给申请人
  createNotification(req.userId, 'content', 'edit-request-approved',
    '编辑权限申请已通过', noteSnippet(note.content),
    { noteId: id, requestId: reqId },
  ).catch(() => {});
  // 申请已处理, 标已读所有作者+admin 收到的 edit-request 通知 (不让通知中心仍显红点)
  markRequestNotificationsRead(['edit-request'], reqId).catch(() => {});
  await logAudit(c, 'note.edit_approve', 'note', id, { requestId: reqId, granteeId: req.userId });
  return c.json({ data: { message: '已同意, 申请人已获得永久编辑权' } });
});

// POST /api/notes/:id/edit-requests/:reqId/reject - 拒绝 (作者+群 admin)
app.post('/:id/edit-requests/:reqId/reject', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id, reqId } = c.req.param();

  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  const isAuthor = note.userId === userId;
  if (!isAuthor && !(await isAdminOfSharedNote(userId, id))) {
    return c.json({ error: '只有作者或群管理员可以审批' }, 403);
  }
  const req = await db.select().from(schema.noteEditRequests)
    .where(and(eq(schema.noteEditRequests.id, reqId), eq(schema.noteEditRequests.noteId, id))).get();
  if (!req) return c.json({ error: '申请不存在' }, 404);
  if (req.status !== 'pending') return c.json({ error: '该申请已处理' }, 400);

  const now = dayjs().toISOString();
  await db.update(schema.noteEditRequests).set({
    status: 'rejected', handledAt: now, handledBy: userId,
  }).where(eq(schema.noteEditRequests.id, reqId));

  publish(req.userId, 'note-edit-request-resolved', {
    requestId: reqId, noteId: id, status: 'rejected', handledBy: userId,
  }, _ocid);
  // 写通知给申请人
  createNotification(req.userId, 'content', 'edit-request-rejected',
    '编辑权限申请被拒绝', noteSnippet(note.content),
    { noteId: id, requestId: reqId },
  ).catch(() => {});
  // 申请已处理, 标已读所有作者+admin 收到的 edit-request 通知
  markRequestNotificationsRead(['edit-request'], reqId).catch(() => {});
  await logAudit(c, 'note.edit_reject', 'note', id, { requestId: reqId, requesterId: req.userId });
  return c.json({ data: { message: '已拒绝' } });
});

// GET /api/notes/:id/edit-requests - 列出该笔记所有申请 (按时间倒序, 含申请人 nickname/avatar)
app.get('/:id/edit-requests', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();

  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  const isAuthor = note.userId === userId;
  if (!isAuthor && !(await isAdminOfSharedNote(userId, id))) {
    return c.json({ error: '只有作者或群管理员可以查看申请' }, 403);
  }

  const reqs = await db.select({
    id: schema.noteEditRequests.id,
    userId: schema.noteEditRequests.userId,
    status: schema.noteEditRequests.status,
    message: schema.noteEditRequests.message,
    createdAt: schema.noteEditRequests.createdAt,
    handledAt: schema.noteEditRequests.handledAt,
    handledBy: schema.noteEditRequests.handledBy,
    nickname: schema.users.nickname,
    avatar: schema.users.avatar,
  }).from(schema.noteEditRequests)
    .leftJoin(schema.users, eq(schema.users.id, schema.noteEditRequests.userId))
    .where(eq(schema.noteEditRequests.noteId, id))
    .orderBy(desc(schema.noteEditRequests.createdAt))
    .all();
  return c.json({ data: reqs });
});

// GET /api/notes/:id/edit-grants - 列已授权用户 (作者+群 admin 看)
app.get('/:id/edit-grants', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();

  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  const isAuthor = note.userId === userId;
  if (!isAuthor && !(await isAdminOfSharedNote(userId, id))) {
    return c.json({ error: '只有作者或群管理员可以查看' }, 403);
  }

  const grants = await db.select({
    userId: schema.noteEditGrants.userId,
    grantedAt: schema.noteEditGrants.grantedAt,
    grantedBy: schema.noteEditGrants.grantedBy,
    nickname: schema.users.nickname,
    avatar: schema.users.avatar,
  }).from(schema.noteEditGrants)
    .leftJoin(schema.users, eq(schema.users.id, schema.noteEditGrants.userId))
    .where(eq(schema.noteEditGrants.noteId, id))
    .all();
  return c.json({ data: grants });
});

// DELETE /api/notes/:id/edit-grants/:userId - 撤销某用户的编辑权 (作者+群 admin)
app.delete('/:id/edit-grants/:userId', async (c) => {
  const me = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  const targetUserId = c.req.param('userId');

  const note = await getNoteForAccess(me, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  const isAuthor = note.userId === me;
  if (!isAuthor && !(await isAdminOfSharedNote(me, id))) {
    return c.json({ error: '只有作者或群管理员可以撤销授权' }, 403);
  }

  await db.delete(schema.noteEditGrants).where(and(
    eq(schema.noteEditGrants.noteId, id),
    eq(schema.noteEditGrants.userId, targetUserId),
  ));
  // 推 SSE 给被撤销人让他前端刷 canWrite (NoteCard 预判 / NoteEditModal 进 modal 前判断)
  publish(targetUserId, 'note-edit-grant-revoked', { noteId: id }, _ocid);
  await logAudit(c, 'note.edit_grant_revoke', 'note', id, { revokedUserId: targetUserId });
  return c.json({ data: { message: '已撤销编辑权' } });
});

// GET /api/notes/:id/edit-history - 列编辑历史 (非作者编辑次数). NoteDetail "X 人编辑过" 胶囊 popover 用.
// 鉴权: getNoteForAccess(read) - 能看到笔记的人都能看历史 (作者 + 共享群 active member). 私有笔记理论上永远空数组但仍能 GET.
// 跨群信息泄露: 笔记 N 分享给 G1, G2. X 在 G1 改过 → G2 成员通过该 API 知道 X 改过笔记, 即使 X 不在 G2.
// 修法: 编辑者只列"调用者也在的群里也是成员"的人, 跨群编辑者匿名化 (用 '群成员' 占位 nickname, avatar=null, userId 仍返用于幂等).
app.get('/:id/edit-history', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();

  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);

  const rows = await db.select({
    id: schema.noteEditHistory.id,
    userId: schema.noteEditHistory.userId,
    editedAt: schema.noteEditHistory.editedAt,
    nickname: schema.users.nickname,
    avatar: schema.users.avatar,
  }).from(schema.noteEditHistory)
    .leftJoin(schema.users, eq(schema.users.id, schema.noteEditHistory.userId))
    .where(eq(schema.noteEditHistory.noteId, id))
    .orderBy(desc(schema.noteEditHistory.editedAt))
    .all();

  // 调用者是作者 → 全显示 (作者本来就知道自己的笔记被谁改过)
  // 否则跨群匿名: 编辑者跟我有共同 active 群才显示 nickname/avatar; 没共同群的匿名为 "群成员"
  const isAuthor = note.userId === userId;
  if (isAuthor || rows.length === 0) return c.json({ data: rows });
  const editorIds = [...new Set(rows.map(r => r.userId))];
  if (editorIds.length === 0) return c.json({ data: rows });
  // 一次性查"我所在 active 群" 跟 "编辑者所在 active 群" 的交集, 拿到我跟谁有共同群
  const sharedSet = new Set<string>();
  const myGroups = await db.select({ groupId: schema.groupMembers.groupId })
    .from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.userId, userId), eq(schema.groupMembers.status, 'active')))
    .all();
  if (myGroups.length > 0) {
    const myGroupIds = myGroups.map(g => g.groupId);
    const peers = await db.select({ userId: schema.groupMembers.userId })
      .from(schema.groupMembers)
      .where(and(
        inArray(schema.groupMembers.userId, editorIds),
        inArray(schema.groupMembers.groupId, myGroupIds),
        eq(schema.groupMembers.status, 'active'),
      )).all();
    for (const p of peers) sharedSet.add(p.userId);
  }
  const masked = rows.map(r => sharedSet.has(r.userId) ? r : ({
    ...r, nickname: '群成员', avatar: null,
  }));
  return c.json({ data: masked });
});

// ─────────────────────────────────────────────────────────────────────────
// 表情 reaction + 评论 thread (共享笔记互动)
// 鉴权: getNoteForAccess(read) 让所有"能看到笔记"的人都能 reaction / 评论 (跟 read 同范围, 比 write 宽).
// 范围: 仅 shared 笔记 (private 笔记自己跟自己 reaction / 评论无语义).
// SSE: broadcastNoteSocial 推该笔记所属群所有 active 成员 + 作者 (除发起人)
// ─────────────────────────────────────────────────────────────────────────

// broadcast 给笔记可见范围内所有人 (该笔记所属群所有 active member ∪ 作者). reaction / comment 增删改用.
// 跟 broadcastNoteShared (给群 feed reload 用) 不同: 这个直接推 note-level 事件让 NoteDetail / NoteEditModal 增量更新.
async function broadcastNoteSocial(noteId: string, eventName: string, payload: any, exceptUserId: string, originClientId?: string) {
  const shared = await db.select({ groupId: schema.noteShares.groupId })
    .from(schema.noteShares).where(eq(schema.noteShares.noteId, noteId)).all();
  if (shared.length === 0) return;
  const members = await db.select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(and(
      inArray(schema.groupMembers.groupId, shared.map(s => s.groupId)),
      eq(schema.groupMembers.status, 'active'),
    )).all();
  const note = await db.select({ userId: schema.notes.userId }).from(schema.notes)
    .where(eq(schema.notes.id, noteId)).get();
  const recipients = new Set<string>(members.map(m => m.userId));
  if (note) recipients.add(note.userId); // 作者可能不在任一目标群里仍要收到
  recipients.delete(exceptUserId);
  for (const uid of recipients) {
    publish(uid, eventName, payload, originClientId);
  }
}

// helper: 批量拉一组笔记的 reaction summary + comment count, 给列表 API enrich 用
// (GET /api/notes 主列表, GET /api/groups/:id/notes 群 feed 同款 NoteCard 渲染需要).
// 只对 shared 笔记有数据 (private 笔记 reaction/comment 不存在表里); private 笔记拉到也是空, 不区分.
// reactionMap 按白名单 5 个 emoji 固定顺序输出 (有数据的笔记才进 map; 没数据的调用方按缺省视为空 array).
export async function loadSocialMetaMaps(noteIds: string[], userId: string): Promise<{
  reactionMap: Map<string, Array<{ emoji: string; count: number; mine: boolean }>>;
  commentCountMap: Map<string, number>;
}> {
  if (noteIds.length === 0) return { reactionMap: new Map(), commentCountMap: new Map() };
  const [reactionRows, commentRows] = await Promise.all([
    db.select({
      noteId: schema.noteReactions.noteId,
      emoji: schema.noteReactions.emoji,
      userId: schema.noteReactions.userId,
    }).from(schema.noteReactions).where(inArray(schema.noteReactions.noteId, noteIds)).all(),
    db.select({
      noteId: schema.noteComments.noteId,
      count: sql<number>`count(*)`,
    }).from(schema.noteComments)
      .where(and(
        inArray(schema.noteComments.noteId, noteIds),
        sql`${schema.noteComments.deletedAt} IS NULL`,
      ))
      .groupBy(schema.noteComments.noteId).all(),
  ]);
  const perNote = new Map<string, Map<string, { count: number; mine: boolean }>>();
  for (const r of reactionRows) {
    let nm = perNote.get(r.noteId);
    if (!nm) { nm = new Map(); perNote.set(r.noteId, nm); }
    const cur = nm.get(r.emoji) || { count: 0, mine: false };
    cur.count += 1;
    if (r.userId === userId) cur.mine = true;
    nm.set(r.emoji, cur);
  }
  const reactionMap = new Map<string, Array<{ emoji: string; count: number; mine: boolean }>>();
  for (const noteId of perNote.keys()) {
    const nm = perNote.get(noteId)!;
    reactionMap.set(noteId, ALLOWED_REACTION_EMOJIS.map(e => ({ emoji: e, ...(nm.get(e) || { count: 0, mine: false }) })));
  }
  const commentCountMap = new Map<string, number>();
  for (const c of commentRows) commentCountMap.set(c.noteId, c.count);
  return { reactionMap, commentCountMap };
}

// helper: 拉单笔记 reaction 汇总 (POST/GET reactions 用). 复用 loadSocialMetaMaps 保口径一致.
async function getReactionSummary(noteId: string, userId: string): Promise<Array<{ emoji: string; count: number; mine: boolean }>> {
  const { reactionMap } = await loadSocialMetaMaps([noteId], userId);
  return reactionMap.get(noteId) || ALLOWED_REACTION_EMOJIS.map(e => ({ emoji: e, count: 0, mine: false }));
}

// POST /api/notes/:id/reactions — toggle 自己的 reaction. body { emoji }
// 已有 (note,user,emoji) → DELETE 取消; 否则 INSERT 添加. 返回新 summary + action.
app.post('/:id/reactions', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({} as any));
  const emoji = typeof body?.emoji === 'string' ? body.emoji : null;
  if (!emoji || !(ALLOWED_REACTION_EMOJIS as readonly string[]).includes(emoji)) {
    return c.json({ error: '不支持的 emoji' }, 400);
  }

  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  if (note.visibility !== 'shared') return c.json({ error: '私有笔记不支持表情' }, 400);

  const existing = await db.select().from(schema.noteReactions)
    .where(and(
      eq(schema.noteReactions.noteId, id),
      eq(schema.noteReactions.userId, userId),
      eq(schema.noteReactions.emoji, emoji),
    )).get();

  let action: 'added' | 'removed';
  if (existing) {
    await db.delete(schema.noteReactions).where(and(
      eq(schema.noteReactions.noteId, id),
      eq(schema.noteReactions.userId, userId),
      eq(schema.noteReactions.emoji, emoji),
    ));
    action = 'removed';
  } else {
    await db.insert(schema.noteReactions).values({
      noteId: id, userId, emoji, createdAt: dayjs().toISOString(),
    });
    action = 'added';
  }

  const summary = await getReactionSummary(id, userId);
  broadcastNoteSocial(id, 'note-reaction-changed', { noteId: id, summary }, userId, _ocid)
    .catch(e => console.error('[reactions] broadcast failed:', e));
  // 多设备同步: 给操作者本人所有设备 publish (broadcastNoteSocial 排除发起人 userId 同账号其他设备也漏)
  publish(userId, 'note-reaction-changed', { noteId: id, summary }, _ocid);
  await logAudit(c, 'note.reaction', 'note', id, { emoji, action });
  return c.json({ data: { action, summary } });
});

// 每人完成待办的聚合: 所在群 (单群) active 成员数 = total; note_todo_done 记录数 = completed; mine = 我有记录.
// 群组聚合完成 = 全员完成 (completed>=total) OR 超过 roster_due_at (运行时算, 不落字段, 见 GROUP-TODO-DESIGN.md [C]).
async function getTodoDoneSummary(noteId: string, userId: string, rosterDueAt: string | null): Promise<{ completed: number; total: number; mine: boolean; groupDone: boolean }> {
  const share = await db.select({ groupId: schema.noteShares.groupId })
    .from(schema.noteShares).where(eq(schema.noteShares.noteId, noteId)).get();
  let total = 0;
  if (share) {
    const t = await db.select({ c: sql<number>`count(*)` })
      .from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.groupId, share.groupId), eq(schema.groupMembers.status, 'active'))).get();
    total = t?.c ?? 0;
  }
  const doneRows = await db.select({ userId: schema.noteTodoDone.userId })
    .from(schema.noteTodoDone).where(eq(schema.noteTodoDone.noteId, noteId)).all();
  const completed = doneRows.length;
  const overdue = !!rosterDueAt && dayjs().isAfter(dayjs(rosterDueAt));
  return { completed, total, mine: doneRows.some(r => r.userId === userId), groupDone: (total > 0 && completed >= total) || overdue };
}

// 批量版 (笔记列表 enrich 用). 传入的 noteIds 应都是 everyone 待办. 返回 Map<noteId, {completed,total,mine}>;
// groupDone 由调用方用各自 rosterDueAt 运行时算 (避免这里再 join 一次 notes).
async function loadTodoDoneMaps(noteIds: string[], userId: string): Promise<Map<string, { completed: number; total: number; mine: boolean; groupName: string | null }>> {
  const map = new Map<string, { completed: number; total: number; mine: boolean; groupName: string | null }>();
  if (noteIds.length === 0) return map;
  const [doneRows, sharesRows] = await Promise.all([
    db.select({ noteId: schema.noteTodoDone.noteId, userId: schema.noteTodoDone.userId })
      .from(schema.noteTodoDone).where(inArray(schema.noteTodoDone.noteId, noteIds)).all(),
    db.select({ noteId: schema.noteShares.noteId, groupId: schema.noteShares.groupId })
      .from(schema.noteShares).where(inArray(schema.noteShares.noteId, noteIds)).all(),
  ]);
  const noteGroup = new Map<string, string>(); // noteId → groupId (everyone 限单群, 取第一个)
  for (const s of sharesRows) if (!noteGroup.has(s.noteId)) noteGroup.set(s.noteId, s.groupId);
  const groupIds = [...new Set(noteGroup.values())];
  const memberCounts = new Map<string, number>();
  const groupNames = new Map<string, string>();  // groupId → name (个人列表显示"来自 X 群")
  if (groupIds.length > 0) {
    const [counts, gs] = await Promise.all([
      db.select({ groupId: schema.groupMembers.groupId, c: sql<number>`count(*)` })
        .from(schema.groupMembers)
        .where(and(inArray(schema.groupMembers.groupId, groupIds), eq(schema.groupMembers.status, 'active')))
        .groupBy(schema.groupMembers.groupId).all(),
      db.select({ id: schema.groups.id, name: schema.groups.name })
        .from(schema.groups).where(inArray(schema.groups.id, groupIds)).all(),
    ]);
    for (const r of counts) memberCounts.set(r.groupId, r.c);
    for (const g of gs) groupNames.set(g.id, g.name);
  }
  const doneByNote = new Map<string, Set<string>>();
  for (const d of doneRows) {
    let s = doneByNote.get(d.noteId); if (!s) { s = new Set(); doneByNote.set(d.noteId, s); }
    s.add(d.userId);
  }
  for (const noteId of noteIds) {
    const doneSet = doneByNote.get(noteId) || new Set<string>();
    const gid = noteGroup.get(noteId);
    map.set(noteId, { completed: doneSet.size, total: gid ? (memberCounts.get(gid) || 0) : 0, mine: doneSet.has(userId), groupName: gid ? (groupNames.get(gid) || null) : null });
  }
  return map;
}

// POST /api/notes/:id/todo-done — 每人完成待办: 当前用户 toggle 自己的完成 (照搬 reaction toggle).
// 任何能 read 该 shared everyone 待办的群成员都能切自己的 (不碰笔记内容, 不要编辑锁/admin).
app.post('/:id/todo-done', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  if (note.type !== 'todo' || note.todoGroupMode !== 'everyone') {
    return c.json({ error: '只有"每人完成"待办支持此操作' }, 400);
  }
  const existing = await db.select().from(schema.noteTodoDone)
    .where(and(eq(schema.noteTodoDone.noteId, id), eq(schema.noteTodoDone.userId, userId))).get();
  let action: 'done' | 'undone';
  if (existing) {
    await db.delete(schema.noteTodoDone)
      .where(and(eq(schema.noteTodoDone.noteId, id), eq(schema.noteTodoDone.userId, userId)));
    action = 'undone';
  } else {
    await db.insert(schema.noteTodoDone).values({ noteId: id, userId, doneAt: dayjs().toISOString() });
    action = 'done';
  }
  const summary = await getTodoDoneSummary(id, userId, note.rosterDueAt);
  // SSE: 群其他成员 (聚合进度变) + 本人其他设备
  broadcastNoteSocial(id, 'note-todo-done-changed', { noteId: id, summary }, userId, _ocid)
    .catch(e => console.error('[todo-done] broadcast failed:', e));
  publish(userId, 'note-todo-done-changed', { noteId: id, summary }, _ocid);
  return c.json({ data: { action, summary } });
});

// GET /api/notes/:id/reactions — 列汇总, 含 mine 标记 (用户已加的 emoji)
app.get('/:id/reactions', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  const summary = await getReactionSummary(id, userId);
  return c.json({ data: summary });
});

const createCommentSchema = z.object({
  content: z.string().trim().min(1).max(COMMENT_MAX_LEN),
  parentId: z.string().nullable().optional(),
});
const updateCommentSchema = z.object({
  content: z.string().trim().min(1).max(COMMENT_MAX_LEN),
});

// POST /api/notes/:id/comments — 创建评论. parentId 走单层 thread normalize:
// 顶层评论传 null/undefined; 一级回复传顶层 id; 二级及以下传任意已存在 id → 最终 parentId 落到根 (顶层) 上.
app.post('/:id/comments', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const parsed = createCommentSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  if (note.visibility !== 'shared') return c.json({ error: '私有笔记不支持评论' }, 400);

  let normalizedParentId: string | null = null;
  if (parsed.data.parentId) {
    const parent = await db.select().from(schema.noteComments)
      .where(and(
        eq(schema.noteComments.id, parsed.data.parentId),
        eq(schema.noteComments.noteId, id),
        sql`${schema.noteComments.deletedAt} IS NULL`,
      )).get();
    if (!parent) return c.json({ error: '父评论不存在' }, 404);
    // 顶层 parent.parentId == null → 用 parent.id (一级回复); 一级回复 parent.parentId != null → 用 parent.parentId (归到根)
    normalizedParentId = parent.parentId ?? parent.id;
  }

  const cid = nanoid(12);
  const now = dayjs().toISOString();
  // 评论内容 sanitize 防 javascript: 注入
  const sanitizedContent = sanitizeUserMarkdown(parsed.data.content);
  const newComment: schema.NewNoteComment = {
    id: cid, noteId: id, userId, parentId: normalizedParentId,
    content: sanitizedContent, createdAt: now, updatedAt: now, deletedAt: null,
  };
  await db.insert(schema.noteComments).values(newComment);

  // 拼 user info: SSE payload 跟返回值同款 (前端不用再 fetch 用户信息)
  const user = await db.select({ nickname: schema.users.nickname, avatar: schema.users.avatar })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  const enriched = { ...newComment, userNickname: user?.nickname || '用户', userAvatar: user?.avatar || null };

  broadcastNoteSocial(id, 'note-comment-added', { noteId: id, comment: enriched }, userId, _ocid)
    .catch(e => console.error('[comments] broadcast failed:', e));
  // 多设备同步: CommentThread.onCommentAdded 已有 id 去重防重 push
  publish(userId, 'note-comment-added', { noteId: id, comment: enriched }, _ocid);
  // 写通知给笔记作者 (除非评论的是自己的笔记). reaction 不写通知 (频率太高)
  if (note.userId !== userId) {
    createNotification(note.userId, 'content', 'comment-added',
      `${user?.nickname || '用户'} 评论了你的笔记`,
      noteSnippet(sanitizedContent),
      { noteId: id, commentId: cid, fromUserId: userId },
    ).catch(() => {});
  }
  await logAudit(c, 'note.comment_create', 'comment', cid, { noteId: id, isReply: !!normalizedParentId });
  return c.json({ data: enriched }, 201);
});

// GET /api/notes/:id/comments — 列所有未删评论 (含 user nickname/avatar). 前端组 thread.
app.get('/:id/comments', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);

  const rows = await db.select({
    id: schema.noteComments.id,
    noteId: schema.noteComments.noteId,
    userId: schema.noteComments.userId,
    parentId: schema.noteComments.parentId,
    content: schema.noteComments.content,
    createdAt: schema.noteComments.createdAt,
    updatedAt: schema.noteComments.updatedAt,
    userNickname: schema.users.nickname,
    userAvatar: schema.users.avatar,
  }).from(schema.noteComments)
    .leftJoin(schema.users, eq(schema.users.id, schema.noteComments.userId))
    .where(and(
      eq(schema.noteComments.noteId, id),
      sql`${schema.noteComments.deletedAt} IS NULL`,
    ))
    .orderBy(schema.noteComments.createdAt)
    .all();
  return c.json({ data: rows });
});

// PATCH /api/notes/:id/comments/:cid — 编辑评论 (仅本人, 无时限)
app.patch('/:id/comments/:cid', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id, cid } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const parsed = updateCommentSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);

  const comment = await db.select().from(schema.noteComments)
    .where(and(eq(schema.noteComments.id, cid), eq(schema.noteComments.noteId, id))).get();
  if (!comment || comment.deletedAt) return c.json({ error: '评论不存在' }, 404);
  if (comment.userId !== userId) return c.json({ error: '只能编辑自己的评论' }, 403);

  const now = dayjs().toISOString();
  // sanitize 评论内容防恶意 markdown
  const sanitizedContent = sanitizeUserMarkdown(parsed.data.content);
  await db.update(schema.noteComments).set({
    content: sanitizedContent, updatedAt: now,
  }).where(eq(schema.noteComments.id, cid));

  // SSE payload 加 user nickname/avatar (前端组渲染用)
  const u = await db.select({ nickname: schema.users.nickname, avatar: schema.users.avatar })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  broadcastNoteSocial(id, 'note-comment-updated', {
    noteId: id, commentId: cid, content: sanitizedContent, updatedAt: now,
    userNickname: u?.nickname || '用户', userAvatar: u?.avatar || null,
  }, userId, _ocid).catch(e => console.error('[comments] broadcast failed:', e));
  // 多设备同步: CommentThread.onCommentUpdated 用 findIndex 已是幂等
  publish(userId, 'note-comment-updated', {
    noteId: id, commentId: cid, content: sanitizedContent, updatedAt: now,
    userNickname: u?.nickname || '用户', userAvatar: u?.avatar || null,
  }, _ocid);
  await logAudit(c, 'note.comment_update', 'comment', cid, { noteId: id });
  return c.json({ data: { ...comment, content: sanitizedContent, updatedAt: now } });
});

// DELETE /api/notes/:id/comments/:cid — 软删 (deletedAt). 本人 OR 笔记作者 OR 群 admin 都能删.
app.delete('/:id/comments/:cid', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id, cid } = c.req.param();

  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  const comment = await db.select().from(schema.noteComments)
    .where(and(eq(schema.noteComments.id, cid), eq(schema.noteComments.noteId, id))).get();
  if (!comment || comment.deletedAt) return c.json({ error: '评论不存在' }, 404);

  const isOwn = comment.userId === userId;
  const isAuthor = note.userId === userId;
  const isAdmin = !isAuthor && !isOwn && (await isAdminOfSharedNote(userId, id));
  if (!isOwn && !isAuthor && !isAdmin) {
    return c.json({ error: '只能删除自己的评论 (作者或群管理员可删任何评论)' }, 403);
  }

  const now = dayjs().toISOString();
  // 删根评论时级联软删所有子评论 (parentId=cid). 防子评论挂死 (前端组 thread 时找不到 parent).
  // 单层 thread (二级评论也都归到顶层 cid 作 parentId), 一次 UPDATE 即可清完
  const deletedCommentIds: string[] = [cid];
  if (comment.parentId === null) {
    // 这是根评论, 找所有挂在它下面的子评论一起软删
    const children = await db.select({ id: schema.noteComments.id }).from(schema.noteComments)
      .where(and(
        eq(schema.noteComments.parentId, cid),
        sql`${schema.noteComments.deletedAt} IS NULL`,
      )).all();
    deletedCommentIds.push(...children.map(c => c.id));
  }
  await db.update(schema.noteComments).set({ deletedAt: now })
    .where(inArray(schema.noteComments.id, deletedCommentIds));

  // 广播每条删除事件给所有读者 (子评论数量通常 ≤10, 不需合并)
  for (const did of deletedCommentIds) {
    broadcastNoteSocial(id, 'note-comment-deleted', { noteId: id, commentId: did }, userId, _ocid)
      .catch(e => console.error('[comments] broadcast failed:', e));
    publish(userId, 'note-comment-deleted', { noteId: id, commentId: did }, _ocid);
  }
  await logAudit(c, 'note.comment_delete', 'comment', cid, {
    noteId: id, cascadedCount: deletedCommentIds.length - 1,
  });
  return c.json({ data: { message: '已删除', deletedCount: deletedCommentIds.length } });
});

// GET /api/notes/:id
// 作者拿自己的笔记 → 直接返回 (含 sharedGroupIds 给编辑器恢复)
// 群成员拿别人共享笔记 → 校验 note_shares 跟我所在群有交集才放行
app.get('/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  const note = await db.select().from(schema.notes).where(eq(schema.notes.id, id)).get();
  if (!note) return c.json({ error: '笔记不存在' }, 404);

  if (note.userId !== userId) {
    // 不是作者: 必须笔记 shared 且在我所在群之一
    const shared = await db.select({ groupId: schema.noteShares.groupId })
      .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).all();
    if (shared.length === 0) return c.json({ error: '笔记不存在' }, 404);
    const myGroups = await db.select({ groupId: schema.groupMembers.groupId })
      .from(schema.groupMembers)
      .where(and(
        eq(schema.groupMembers.userId, userId),
        eq(schema.groupMembers.status, 'active'),
        inArray(schema.groupMembers.groupId, shared.map(s => s.groupId)),
      )).get();
    if (!myGroups) return c.json({ error: '笔记不存在' }, 404);
  }

  const shares = await db.select({ groupId: schema.noteShares.groupId })
    .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).all();
  // shared 笔记带 reaction summary + comment count, NoteDetail 直接用 (省一个 round trip + SSE 增量更新)
  // shared 笔记带 editorCount, NoteDetail "X 人编辑过" 胶囊用
  // shared 笔记带 canWrite, NoteCard / NoteDetail 预判"点编辑能否进 modal"
  // enrich authorNickname/Avatar, NoteDetail 顶部 chip 显示别人发布的笔记作者头像+昵称 (跟 NoteCard 一致)
  const author = await db.select({ nickname: schema.users.nickname, avatar: schema.users.avatar })
    .from(schema.users).where(eq(schema.users.id, note.userId)).get();
  let enriched: any = {
    ...note,
    sharedGroupIds: shares.map(s => s.groupId),
    authorNickname: author?.nickname ?? null,
    authorAvatar: author?.avatar ?? null,
  };
  if (note.visibility === 'shared') {
    const [{ reactionMap, commentCountMap }, editorCountMap, canWriteMap] = await Promise.all([
      loadSocialMetaMaps([id], userId),
      loadEditorCountMap([id]),
      loadCanWriteMap([{
        id: note.id, userId: note.userId, editPermission: note.editPermission,
        sharedGroupIds: shares.map(s => s.groupId),
      }], userId),
    ]);
    enriched.reactionSummary = reactionMap.get(id) || ALLOWED_REACTION_EMOJIS.map(e => ({ emoji: e, count: 0, mine: false }));
    enriched.commentCount = commentCountMap.get(id) || 0;
    enriched.editorCount = editorCountMap.get(id) || 0;
    enriched.canWrite = canWriteMap.get(id) ?? false;
    // 每人完成待办: 详情显示进度 + 名单 (rosterVisibility=full 或我是 admin 才给名单) + 群名. 单群 → 名单基于该群成员.
    if (note.type === 'todo' && note.todoGroupMode === 'everyone' && shares.length > 0) {
      const gid = shares[0].groupId;
      const [members, doneRows, grp] = await Promise.all([
        db.select({ userId: schema.groupMembers.userId, nickname: schema.users.nickname, avatar: schema.users.avatar })
          .from(schema.groupMembers).innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
          .where(and(eq(schema.groupMembers.groupId, gid), eq(schema.groupMembers.status, 'active'))).all(),
        db.select({ userId: schema.noteTodoDone.userId }).from(schema.noteTodoDone).where(eq(schema.noteTodoDone.noteId, id)).all(),
        db.select({ name: schema.groups.name }).from(schema.groups).where(eq(schema.groups.id, gid)).get(),
      ]);
      const doneSet = new Set(doneRows.map(d => d.userId));
      const isAdmin = await isAdminOfGroups(userId, [gid]);
      const showRoster = note.rosterVisibility === 'full' || isAdmin;
      const overdue = !!note.rosterDueAt && dayjs().isAfter(dayjs(note.rosterDueAt));
      enriched.todoDoneSummary = {
        completed: doneSet.size, total: members.length, mine: doneSet.has(userId),
        groupDone: (members.length > 0 && doneSet.size >= members.length) || overdue,
        groupName: grp?.name ?? null,
        hideProgress: note.rosterVisibility === 'none' && !isAdmin, // none + 非管理员: 隐藏进度 + 名单 (只完成勾)
        roster: showRoster ? members.map(m => ({ userId: m.userId, nickname: m.nickname, avatar: m.avatar, done: doneSet.has(m.userId) })) : undefined,
      };
    }
  }
  return c.json({ data: enriched });
});

// POST /api/notes
app.post('/', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const body = await c.req.json();
  const parsed = createNoteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // visibility 校验: shared 必须给非空 sharedGroupIds + 全是我所在的群; private 不能带 sharedGroupIds
  const visibility = parsed.data.visibility;
  const sharedGroupIds = parsed.data.sharedGroupIds ?? [];
  if (visibility === 'shared' && sharedGroupIds.length === 0) {
    return c.json({ error: 'visibility=shared 必须指定至少 1 个 sharedGroupIds' }, 400);
  }
  if (visibility === 'private' && sharedGroupIds.length > 0) {
    return c.json({ error: 'visibility=private 不能带 sharedGroupIds' }, 400);
  }
  if (sharedGroupIds.length > 0) {
    const err = await validateSharedGroups(userId, sharedGroupIds);
    if (err) return c.json({ error: err }, 403);
  }

  // 群组待办子类型 (GROUP-TODO-DESIGN.md): 仅 shared todo 有意义
  let todoGroupMode: 'group' | 'everyone' | null = null;
  let rosterDueAt: string | null = null;
  let rosterVisibility: 'count' | 'full' | 'none' | null = null;
  if (parsed.data.type === 'todo' && visibility === 'shared') {
    if (parsed.data.todoGroupMode === 'everyone') {
      // 每人完成待办: 仅群管理员能发, 限单群 (聚合 X/N + 名单语义才清晰)
      if (sharedGroupIds.length !== 1) {
        return c.json({ error: '"每人完成"待办只能分享到 1 个群' }, 400);
      }
      if (!(await isAdminOfGroups(userId, sharedGroupIds))) {
        return c.json({ error: '只有群管理员能发"每人完成"待办' }, 403);
      }
      todoGroupMode = 'everyone';
      rosterDueAt = parsed.data.rosterDueAt ?? null;
      rosterVisibility = parsed.data.rosterVisibility ?? 'count';
    } else {
      todoGroupMode = 'group'; // 默认群级待办 (任何成员可发, 发起人+admin 控完成)
    }
  }

  const now = dayjs().toISOString();
  const note = {
    id: nanoid(12),
    userId,
    content: parsed.data.content,
    contentPinyin: toPinyinSearchable(parsed.data.content),
    type: parsed.data.type,
    category: parsed.data.category ?? null,
    tags: parsed.data.tags ?? [],
    todoStatus: parsed.data.type === 'todo' ? 'pending' as const : null,
    todoGroupMode,
    rosterDueAt,
    rosterVisibility,
    summary: null,
    aiProcessed: false,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    visibility,
  };

  // 事务: insert note + insert note_shares 一起写, 防分享列表写一半留脏数据
  db.transaction((tx) => {
    tx.insert(schema.notes).values(note).run();
    if (sharedGroupIds.length > 0) {
      tx.insert(schema.noteShares).values(
        sharedGroupIds.map(groupId => ({ noteId: note.id, groupId, sharedAt: now }))
      ).run();
    }
  });

  // 异步 AI 处理（不阻塞响应）. simplifyContent=true (float「AI整理」) 时额外后台精简 content
  processNoteWithAi(userId, note.id, note.content, note.tags as string[], { simplifyContent: parsed.data.simplifyContent, originClientId: _ocid }).catch(() => {});
  // 通知目标群成员有新笔记 (前端 sse handler 收到后在群详情页 reload feed)
  broadcastNoteShared(sharedGroupIds, userId, _ocid).catch(e => console.error('[notes] broadcast failed:', e));
  // 多设备同步: 给作者本人所有设备 publish (broadcastNoteShared 排除发起人, 同账号其他设备一起被排除; 私有笔记不走 broadcast 也漏)
  publish(userId, 'note-created', { noteId: note.id }, _ocid);
  await logAudit(c, 'note.create', 'note', note.id, {
    type: note.type, visibility, sharedGroupIds,
  });

  return c.json({ data: { ...note, sharedGroupIds } }, 201);
});

// duplicate per-user rate-limit. 防批量复制刷数据库
const DUPLICATE_RATE_WINDOW_MS = 60 * 1000;
const DUPLICATE_RATE_MAX = 30; // 每分钟 30 次, 正常用户够用
const duplicateRateMap = new Map<string, { count: number; resetAt: number }>();

// POST /api/notes/:id/duplicate — "另存为" 副本
// 鉴权: 能读到笔记的人都能复制 (作者 + 共享群 active member). 复制后副本归调用人.
// 副本: userId = 当前操作人, visibility = 'private', type 同原, content = 引用块 + 原 content
// tags / category / pinned / todoStatus / todoDue / parentNoteId / 锁字段 / version 都不复制
// 通知原作者: SSE 推 'note-duplicated' (前端 toast / 通知中心)
app.post('/:id/duplicate', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();

  // rate-limit (per-user) 防批量复制
  const nowMs = Date.now();
  const bucket = duplicateRateMap.get(userId);
  if (bucket && bucket.resetAt > nowMs) {
    if (bucket.count >= DUPLICATE_RATE_MAX) {
      return c.json({ error: '复制操作过于频繁, 请稍后再试' }, 429);
    }
    bucket.count++;
  } else {
    duplicateRateMap.set(userId, { count: 1, resetAt: nowMs + DUPLICATE_RATE_WINDOW_MS });
  }

  const original = await getNoteForAccess(userId, id, 'read');
  if (!original) return c.json({ error: '笔记不存在' }, 404);

  // 查原作者 nickname 拼引用抬头. 自己复制自己的笔记也加引用块 (语义统一, 用户可后续编辑去掉)
  const author = await db.select({ nickname: schema.users.nickname }).from(schema.users)
    .where(eq(schema.users.id, original.userId)).get();
  const authorName = author?.nickname || '原作者';
  const originDate = dayjs(original.createdAt).format('YYYY-MM-DD');
  const quote = `> 原作者: @${authorName} ｜ ${originDate}\n\n`;
  const newContent = quote + original.content;

  const now = dayjs().toISOString();
  const newId = nanoid(12);
  const newNote = {
    id: newId,
    userId,
    content: newContent,
    contentPinyin: toPinyinSearchable(newContent),
    type: original.type,
    category: null,
    tags: [],
    todoStatus: original.type === 'todo' ? 'pending' as const : null,
    summary: null,
    aiProcessed: false,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    visibility: 'private' as const,
  };
  await db.insert(schema.notes).values(newNote);

  // 异步 AI 处理副本 (新主人的标签 / 分类 / 摘要重新跑一遍)
  processNoteWithAi(userId, newId, newContent, []).catch(() => {});

  // 多设备同步: 操作者本人所有设备主 view 拉新副本
  publish(userId, 'note-created', { noteId: newId }, _ocid);
  // 通知原作者 (不通知自己复制自己)
  if (original.userId !== userId) {
    const dup = await db.select({ nickname: schema.users.nickname }).from(schema.users)
      .where(eq(schema.users.id, userId)).get();
    publish(original.userId, 'note-duplicated', {
      originNoteId: id,
      newNoteId: newId,
      duplicatorId: userId,
      duplicatorNickname: dup?.nickname || '群成员',
    });
    // 写通知给原作者
    createNotification(original.userId, 'content', 'duplicated',
      `${dup?.nickname || '群成员'} 另存为了你的笔记`,
      noteSnippet(original.content),
      { noteId: id, newNoteId: newId, fromUserId: userId },
    ).catch(() => {});
  }
  await logAudit(c, 'note.duplicate', 'note', newId, {
    originNoteId: id, originAuthorId: original.userId,
  });

  return c.json({ data: { ...newNote, sharedGroupIds: [] } }, 201);
});

// PATCH /api/notes/:id
app.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  const body = await c.req.json();
  const parsed = updateNoteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // 鉴权扩到 shared 笔记的群成员 + write mode 校验 editPermission
  const existing = await getNoteForAccess(userId, id, 'read');
  if (!existing) return c.json({ error: '笔记不存在' }, 404);

  const isAuthor = existing.userId === userId;
  const data = parsed.data;

  // 非作者 + shared 笔记 → 检查 write 权限 (editPermission + grants 白名单)
  if (!isAuthor && existing.visibility === 'shared') {
    const writable = await getNoteForAccess(userId, id, 'write');
    if (!writable) {
      return c.json({
        error: 'no_write_permission',
        editPermission: existing.editPermission,
      }, 403);
    }
  }

  // 非作者编辑共享笔记 → 禁止改 visibility / sharedGroupIds / editPermission (这些是分享设置, 仅作者控)
  if (!isAuthor && (data.visibility !== undefined || data.sharedGroupIds !== undefined || data.editPermission !== undefined)) {
    return c.json({ error: '只有作者可以修改共享设置' }, 403);
  }

  // 字段权限守卫: 非作者改任何笔记 → 静默剥作者私域字段 (category / tags / pinned) + 改 type / todoStatus
  // 要先验证我是群组 admin (前端 UI 已隐藏对应入口, 后端兜底防旧客户端 / curl 直调)
  // - category / tags / pinned: 仅作者能改 (含群主管理员都不能改别人的) → 直接 delete
  // - type / todoStatus: 作者 + 群主/管理员能改 → 非作者时查 isAdminOfSharedNote, 否则 delete
  if (!isAuthor) {
    delete data.category;
    delete data.tags;
    delete data.pinned;
    const isAdmin = existing.visibility === 'shared' && await isAdminOfSharedNote(userId, id);
    if (!isAdmin) {
      delete data.type;
      delete data.todoStatus;
    }
  }

  const now = dayjs().toISOString();
  // skipTimestamp: 任务清单 checkbox 等轻量 toggle 不更新 updatedAt, 避免点一下笔记就按"最后编辑"排到最前
  // (蘑菇 2026-06-29). content 仍照常存 + version 乐观锁仍 ++, 只是不刷新最后编辑时间.
  const skipTimestamp = data.skipTimestamp === true;
  const updates: Record<string, any> = skipTimestamp ? {} : { updatedAt: now };

  // isContentChange / isCollabChange / ctxGroupId / currentShareGroupIds 提前到锁校验之前定义, needLock 跟 fork 决策都用
  // 拆 isCollabChange (锁判断) vs isContentChange (audit/version):
  //   - isCollabChange: 触发"群成员协作冲突"的字段 (content / summary / tags / type / todoStatus) - 多人撞改场景, 需要锁
  //   - isContentChange: 含 category (作者私域字段, 仅作者能改 - 不涉及协作冲突所以不需锁, 但 audit 仍存快照 + version 乐观锁防多 tab 撞)
  // 作者拖共享笔记到分类 (改 category): isCollabChange=false → needLock=false 直接通过; isContentChange=true → audit + version 仍跑
  const isCollabChange = (
    data.content !== undefined ||
    data.summary !== undefined ||
    data.tags !== undefined ||
    data.type !== undefined ||
    data.todoStatus !== undefined
  );
  const isContentChange = isCollabChange || data.category !== undefined;
  const ctxGroupId = data.editContext?.groupId;
  const currentShareGroupIds = (await db.select({ groupId: schema.noteShares.groupId })
    .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).all()).map(r => r.groupId);

  // shared 笔记必须持锁 + version 校验. private 笔记保持原行为 (作者直接改, 不需锁)
  // 唯一免锁场景 = 作者主视图改 root 多群内容. 其它所有 shared 编辑都要锁:
  //   - 非作者改任何 shared 笔记: 协作场景必锁
  //   - 作者改 fork (parentNoteId !== null): fork 是群协作版本
  //   - 作者改 root 单群: 单群 root 等价 fork
  //   - 作者改 root 多群 + 群组页: 该路径会触发 fork (创建该群专属版本), 跟非作者改 root 触发 fork 同款流程
  // 锁主要防"群成员协作时撞改". 作者主视图改多群 root 多设备同步靠 version 乐观锁兜底
  // 加 isCollabChange 前置 - 改管理字段 / 作者私域字段 (editPermission / pinned / visibility / sharedGroupIds / category) 时不走锁
  const needLock = isCollabChange && existing.visibility === 'shared' && (
    !isAuthor ||                                       // 非作者必锁
    existing.parentNoteId !== null ||                  // 作者改 fork 必锁
    currentShareGroupIds.length <= 1 ||                // 单群必锁 (单群 root 等价 fork)
    !!ctxGroupId                                       // 群组页改 root 多群必锁 (会 fork)
  );
  if (needLock) {
    if (!data.lockToken) return c.json({ error: '编辑共享笔记需先申请锁 (POST /:id/lock)' }, 400);
    if (existing.editLockBy !== userId || existing.editLockToken !== data.lockToken) {
      return c.json({ error: 'lock_invalid' }, 409);
    }
    if (existing.editLockExpiresAt && dayjs(existing.editLockExpiresAt).isBefore(dayjs())) {
      return c.json({ error: 'lock_expired' }, 409);
    }
    if (typeof data.version !== 'number') return c.json({ error: '编辑共享笔记需带 version' }, 400);
    if (data.version !== existing.version) {
      return c.json({ error: 'version_conflict', currentVersion: existing.version }, 409);
    }
    // 成功通过校验: version++ + 自动清锁 (PATCH 即提交完成, 锁就释放给下一位)
    updates.version = existing.version + 1;
    updates.editLockBy = null;
    updates.editLockToken = null;
    updates.editLockExpiresAt = null;
  } else if (isContentChange) {
    // 免锁但改内容字段: 维护 version 乐观锁防多设备 / 多 tab 撞改时旧内容覆盖新内容.
    // 覆盖 2 类: (a) private 笔记作者改 (b) shared 作者主视图改 root 多群.
    // 仅在改内容字段时校验 - 管理操作 (pinned / editPermission / visibility / sharedGroupIds) 走 in-place 不强制 version, 兼容 NoteCard 切胶囊等不带 version 的调用方
    if (typeof data.version !== 'number') return c.json({ error: '编辑笔记需带 version' }, 400);
    if (data.version !== existing.version) {
      return c.json({ error: 'version_conflict', currentVersion: existing.version }, 409);
    }
    updates.version = existing.version + 1;
  }
  if (data.content !== undefined) {
    updates.content = data.content;
    updates.contentPinyin = toPinyinSearchable(data.content);
  }
  if (data.summary !== undefined) updates.summary = data.summary;
  if (data.category !== undefined) updates.category = data.category;
  if (data.tags !== undefined) updates.tags = data.tags;
  if (data.type !== undefined) updates.type = data.type;
  // 老笔记从 note/snippet 改成 todo 时, 若原 todoStatus 为 NULL, 自动补 'pending', 跟 POST 新建 todo 语义对齐.
  // 用户显式传 todoStatus 时尊重用户 (走下面 if). 原本已有 todoStatus(如 'done' 从 todo→note→todo 复用)也不动.
  if (data.type === 'todo' && existing.todoStatus == null && data.todoStatus === undefined) {
    updates.todoStatus = 'pending';
  }
  if (data.todoStatus !== undefined) updates.todoStatus = data.todoStatus;
  // todoDue / todoRemindRrule 字段已删, 改提醒走 personal-reminder 接口
  if (data.pinned !== undefined) updates.pinned = data.pinned;
  // 改编辑权限. 仅作者能改 (上面已校验非作者传过来直接 403)
  if (data.editPermission !== undefined) updates.editPermission = data.editPermission;
  // 群组待办类型/截止/可见性 (GROUP-TODO-DESIGN.md): 都是群管理操作, shared 笔记才有意义, 只有群管理员能改.
  // everyone 限单群 (聚合 X/N + 名单语义清晰). 私有笔记前端不传这些字段, 传了也忽略.
  if (existing.visibility === 'shared' && (data.todoGroupMode !== undefined || data.rosterDueAt !== undefined || data.rosterVisibility !== undefined)) {
    if (!(await isAdminOfGroups(userId, currentShareGroupIds))) {
      return c.json({ error: '只有群管理员能改待办类型/截止/可见性' }, 403);
    }
    if (data.todoGroupMode === 'everyone' && currentShareGroupIds.length !== 1) {
      return c.json({ error: '"每人完成"待办只能在单群笔记上设置' }, 400);
    }
    if (data.todoGroupMode !== undefined) updates.todoGroupMode = data.todoGroupMode;
    if (data.rosterDueAt !== undefined) updates.rosterDueAt = data.rosterDueAt;
    if (data.rosterVisibility !== undefined) updates.rosterVisibility = data.rosterVisibility;
  }

  // COW fork 决策. shared 笔记被"群组页打开编辑"的非作者 / 作者改 → 可能 fork 到该群专属版本.
  // (isContentChange / ctxGroupId / currentShareGroupIds 已在锁校验之前定义, 复用)
  let shouldFork = false;
  let effectiveGroupId: string | undefined = ctxGroupId; // 可能被下面自动推断覆盖 (非作者主视图改时)
  if (existing.visibility === 'shared' && isContentChange) {
    if (!isAuthor && existing.parentNoteId === null) {
      // 非作者改 root → fork (创建该群专属版本). 非作者改已是 fork 的笔记 → in-place 改 fork (fork 本身就是该群专属版本, 二次 fork 无意义且把原 fork 变孤儿).
      // 非作者改 shared 必 fork. 但前端不一定能传 editContext (主视图也可能编辑别人共享笔记).
      // 90% case 无歧义: B 在主视图看到 A 共享的笔记 → B 必定是某个共享群的成员 → 算 B 的 active 群 ∩ 笔记共享群
      //   - 交集 1 个 → 自动用那群 (无歧义最常见 case)
      //   - 交集 >1 个 → editContext_ambiguous 让前端引导用户去群组页明确 (罕见: B 同时在多群且都共享了)
      //   - 交集 0 个 → 防御性 400 (理论上 getNoteForAccess(read) 已保证 ≥1)
      if (!effectiveGroupId) {
        const intersect = await db.select({ groupId: schema.groupMembers.groupId })
          .from(schema.groupMembers)
          .where(and(
            eq(schema.groupMembers.userId, userId),
            eq(schema.groupMembers.status, 'active'),
            inArray(schema.groupMembers.groupId, currentShareGroupIds),
          )).all();
        if (intersect.length === 0) {
          return c.json({ error: 'note_not_in_group', message: '该笔记不在你所在的任何群里' }, 400);
        }
        if (intersect.length > 1) {
          return c.json({
            error: 'editContext_ambiguous',
            message: '你在多个群里都能看到这条笔记, 请从群组页面打开编辑',
            candidateGroupIds: intersect.map(m => m.groupId),
          }, 400);
        }
        effectiveGroupId = intersect[0].groupId;
      } else if (!currentShareGroupIds.includes(effectiveGroupId)) {
        return c.json({ error: 'note_not_in_group', message: '该笔记未分享到此群' }, 400);
      }
      // 校验非作者 X 是 effectiveGroupId 群的 active member, 防伪造 editContext.groupId 让 fork 落到 X 不在的群
      // 攻击场景: X 在 G1 看到 B 的笔记, 传 editContext.groupId=G2 (X 不在 G2) → fork 落 G2, 挂着 B 名字写 X 的内容 → 身份冒充
      const myActiveInTarget = await db.select({ groupId: schema.groupMembers.groupId })
        .from(schema.groupMembers)
        .where(and(
          eq(schema.groupMembers.userId, userId),
          eq(schema.groupMembers.groupId, effectiveGroupId),
          eq(schema.groupMembers.status, 'active'),
        )).get();
      if (!myActiveInTarget) {
        return c.json({ error: 'not_member_of_target_group', message: '你不是该群组的成员' }, 403);
      }
      shouldFork = true;
    } else if (effectiveGroupId && existing.parentNoteId === null && currentShareGroupIds.length > 1) {
      // 作者 + 群组页改 + 当前是 root + 分享到多群 → fork (避免作者从群组页改影响其它群)
      if (!currentShareGroupIds.includes(effectiveGroupId)) {
        return c.json({ error: 'note_not_in_group', message: '该笔记未分享到此群' }, 400);
      }
      // 作者也校验自己是 effectiveGroupId 群的 active member (作者可能已退该群, 不应再 fork 进去)
      const authorActiveInTarget = await db.select({ groupId: schema.groupMembers.groupId })
        .from(schema.groupMembers)
        .where(and(
          eq(schema.groupMembers.userId, userId),
          eq(schema.groupMembers.groupId, effectiveGroupId),
          eq(schema.groupMembers.status, 'active'),
        )).get();
      if (!authorActiveInTarget) {
        return c.json({ error: 'not_member_of_target_group', message: '你不是该群组的成员' }, 403);
      }
      shouldFork = true;
    }
    // 其他作者改情况走 in-place:
    //  - 作者无 editContext (灵感页 / 主视图改 root, 多群同步是预期语义)
    //  - 作者改 root + 单群 (fork 单群无意义, 不增加无用 fork)
    //  - 作者改 fork (parentNoteId 非空, 已经是该群专属版本, 不二次分叉)
  }
  // 改 visibility / sharedGroupIds: 校验后整批替换 note_shares (delete all + insert new)
  // 客户端可以三种方式调: 仅传 visibility (改私密性) / 仅传 sharedGroupIds (改群列表) / 两个一起
  // 注: fork 路径不允许改分享设置 (fork 是"在该群版本上改内容", 改分享设置只有作者从主视图 in-place 改)
  if (shouldFork && (data.visibility !== undefined || data.sharedGroupIds !== undefined)) {
    return c.json({ error: 'fork 路径不允许改 visibility / sharedGroupIds, 请去主视图改' }, 400);
  }
  const willUpdateShares = !shouldFork && (data.visibility !== undefined || data.sharedGroupIds !== undefined);
  let newSharedGroupIds: string[] | undefined;
  if (willUpdateShares) {
    const newVisibility = data.visibility ?? existing.visibility;
    newSharedGroupIds = data.sharedGroupIds ?? (newVisibility === 'shared' ? undefined : []);
    if (newVisibility === 'shared' && (!newSharedGroupIds || newSharedGroupIds.length === 0)) {
      return c.json({ error: 'visibility=shared 必须指定 sharedGroupIds (≥1 个群)' }, 400);
    }
    if (newVisibility === 'private' && newSharedGroupIds && newSharedGroupIds.length > 0) {
      return c.json({ error: 'visibility=private 不能带 sharedGroupIds' }, 400);
    }
    // shared → private 转换约束 - 仅 root 笔记 + 无 fork 子节点能转 (有 fork = 已被群编辑过, 转 private 会孤立 fork)
    if (existing.visibility === 'shared' && newVisibility === 'private') {
      if (existing.parentNoteId !== null) {
        return c.json({ error: 'fork 笔记不能转 private (它是某群的独占副本)', code: 'fork_cannot_privatize' }, 409);
      }
      const forks = await db.select({ id: schema.notes.id })
        .from(schema.notes)
        .where(and(
          eq(schema.notes.parentNoteId, existing.id),
          sql`${schema.notes.deletedAt} IS NULL`,
        )).all();
      if (forks.length > 0) {
        return c.json({
          error: `不能转 private: 这条笔记已有 ${forks.length} 个 fork 子版本 (被某群编辑过). 请先到对应群清理 fork 笔记`,
          code: 'has_forks',
          forkCount: forks.length,
        }, 409);
      }
    }
    if (newSharedGroupIds && newSharedGroupIds.length > 0) {
      const err = await validateSharedGroups(userId, newSharedGroupIds);
      if (err) return c.json({ error: err }, 403);
    }
    if (data.visibility !== undefined) updates.visibility = data.visibility;
  }

  // fork 路径: 事务里 forkNote + apply updates to new note + 写 history (非作者时).
  // 不改 original (除 note_shares + group_note_pins 已在 forkNote 内调整). 广播给该群 + 仍连原 note 的其它群.
  if (shouldFork) {
    let newNoteId = '';
    let orphanedRoot = false;
    db.transaction((tx) => {
      newNoteId = forkNote(tx, existing, effectiveGroupId!, now);
      // 把 updates 套到 fork 出的新 note. version / 锁字段在 forkNote 里已重置为 1/null, 不要再 set 进去.
      const forkUpdates = { ...updates };
      delete forkUpdates.version;
      delete forkUpdates.editLockBy;
      delete forkUpdates.editLockToken;
      delete forkUpdates.editLockExpiresAt;
      tx.update(schema.notes).set(forkUpdates).where(eq(schema.notes.id, newNoteId)).run();
      // 持锁人改触发 fork 时, 也要清 original (root) 的锁. 锁是 "PATCH 提交即释放" 语义.
      // 覆盖 2 个 fork 来源: 非作者改 root + 作者群组页改 root 多群 (修订规则后作者也持锁).
      // 作者主视图改 root 多群免锁不持锁, 不进此分支 (editLockBy 是别人或 null)
      if (existing.editLockBy === userId) {
        tx.update(schema.notes).set({
          editLockBy: null,
          editLockToken: null,
          editLockExpiresAt: null,
        }).where(eq(schema.notes.id, id)).run();
      }
      // 孤儿处理 (替代原 "物理删" 决策):
      // forkNote 已删除 (id, effectiveGroupId) 这条 note_shares. 查 existing 剩余 shares 数为 0 →
      // existing 变孤儿 (所有共享群都 fork 走了). 不物理删 (作者可能想保留原稿), 改私密 + 移回收站
      // 让作者可恢复. 锁字段顺便清 (作者 fork 上面没清, 这里补一致性).
      const remaining = tx.select({ count: sql<number>`count(*)` })
        .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).get() as { count: number } | undefined;
      orphanedRoot = (remaining?.count ?? 0) === 0;
      if (orphanedRoot) {
        tx.update(schema.notes).set({
          visibility: 'private',
          deletedAt: now,
          editLockBy: null,
          editLockToken: null,
          editLockExpiresAt: null,
        }).where(eq(schema.notes.id, id)).run();
      }
      // history: 非作者改才写 ("原作者发布 · @B 编辑过", 作者自己不算编辑过)
      if (!isAuthor) {
        tx.insert(schema.noteEditHistory).values({
          id: nanoid(12),
          noteId: newNoteId,
          userId,
          editedAt: now,
        }).run();
      }
    });
    // 广播: 该群成员看到新 fork, 其它仍连 original 的群成员需要刷新 (original 的 sharedGroupIds 里去掉了该群)
    const allGroupIds = [...new Set([effectiveGroupId!, ...currentShareGroupIds])];
    broadcastNoteShared(allGroupIds, userId, _ocid).catch(e => console.error('[notes] broadcast failed:', e));
    // 多设备同步: 给作者本人所有设备 publish 让其他设备 store 拉 fork 新版本
    publish(userId, 'note-updated', { noteId: newNoteId }, _ocid);
    // 孤儿处理软删 root 时 publish 'note-deleted' for root id 给原作者, 让其他设备主 view splice 出 root
    // (本设备 _ocid 跳过, 非作者触发时操作者 clientId 跟作者无关, 作者所有设备都收到)
    if (orphanedRoot) {
      publish(existing.userId, 'note-deleted', { noteId: id }, _ocid);
    }
    await logAudit(c, 'note.update_fork', 'note', newNoteId, {
      originNoteId: id, groupId: effectiveGroupId, isAuthor,
    });

    // fork-by-other 通知 - 非作者改 root 触发 fork 时, 给原作者写一条让他知道笔记在 X 群被 @Y fork 走
    if (!isAuthor && effectiveGroupId) {
      const [group, actor] = await Promise.all([
        db.select({ name: schema.groups.name }).from(schema.groups).where(eq(schema.groups.id, effectiveGroupId)).get(),
        db.select({ nickname: schema.users.nickname }).from(schema.users).where(eq(schema.users.id, userId)).get(),
      ]);
      await createNotification(
        existing.userId, 'content', 'fork-by-other',
        '你的笔记在群组被 fork',
        `${actor?.nickname || '某人'}在「${group?.name || '群组'}」编辑了你的笔记, 生成了该群独占副本: ${noteSnippet(existing.content)}`,
        { noteId: newNoteId, originNoteId: id, groupId: effectiveGroupId, forkedByUserId: userId },
      );
    }

    const newNote = await db.select().from(schema.notes).where(eq(schema.notes.id, newNoteId)).get();
    return c.json({
      data: { ...newNote, sharedGroupIds: [effectiveGroupId!] },
      forked: true,
      forkedFromNoteId: id,
    });
  }

  // 事务: notes update + note_shares 整批替换 + 非作者 history 一起跑, 防写一半留脏数据
  db.transaction((tx) => {
    tx.update(schema.notes).set(updates).where(eq(schema.notes.id, id)).run();
    if (willUpdateShares) {
      tx.delete(schema.noteShares).where(eq(schema.noteShares.noteId, id)).run();
      if (newSharedGroupIds && newSharedGroupIds.length > 0) {
        tx.insert(schema.noteShares).values(
          newSharedGroupIds.map(groupId => ({ noteId: id, groupId, sharedAt: now }))
        ).run();
      }
    }
    // history: 非作者 in-place 改 shared + 改内容 → 写一条 (作者 in-place 改不写)
    if (!isAuthor && existing.visibility === 'shared' && isContentChange) {
      tx.insert(schema.noteEditHistory).values({
        id: nanoid(12),
        noteId: id,
        userId,
        editedAt: now,
      }).run();
    }
  });

  // 广播给 旧 ∪ 新 groupIds 的成员 (旧群刷掉这条笔记, 新群加上这条笔记 / 内容改了也要同步)
  if (willUpdateShares) {
    const allGroupIds = [...new Set([...currentShareGroupIds, ...(newSharedGroupIds || [])])];
    broadcastNoteShared(allGroupIds, userId, _ocid).catch(e => console.error('[notes] broadcast failed:', e));
  } else if (existing.visibility === 'shared') {
    // 只改了内容/tag 没改群列表, 但已经是 shared → 通知所有群成员刷新看新内容
    broadcastNoteShared(currentShareGroupIds, userId, _ocid).catch(e => console.error('[notes] broadcast failed:', e));
  }
  // 多设备同步: 给作者本人所有设备 publish 让其他设备 store 拉单条 refreshSingleNote (复用 scheduler 那条线已有的 note-updated SSE 事件)
  publish(userId, 'note-updated', { noteId: id }, _ocid);
  // 内容变化时拍 before 快照存 audit (跟 delete 时的 snapshot 一致, 让审计可完整回溯任意时刻笔记状态).
  // 仅 isContentChange 存 (pinned/visibility/sharedGroupIds 等管理操作不影响内容, 无快照意义)
  await logAudit(c, 'note.update', 'note', id, {
    fields: Object.keys(updates).filter(k => k !== 'updatedAt'),
    isAuthor,
    ...(isContentChange ? {
      snapshot: {
        content: existing.content,
        tags: existing.tags,
        category: existing.category,
        type: existing.type,
        visibility: existing.visibility,
      },
    } : {}),
  });

  const updated = await db.select().from(schema.notes).where(eq(schema.notes.id, id)).get();
  // 返回 sharedGroupIds 让前端拿到当前最新分享列表
  const shares = await db.select({ groupId: schema.noteShares.groupId })
    .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).all();
  return c.json({ data: { ...updated, sharedGroupIds: shares.map(s => s.groupId) } });
});

// DELETE /api/notes/:id — 软删除（移入回收站）
// 约定: 任何人删共享笔记都进所有相关群的回收站 (群 trash query 走 note_shares JOIN).
// 个人 trash 仅 "root 最后一份留存 (parent_note_id IS NULL + 无 fork 子节点)" 显示 (查询时过滤, 写入端不区分).
// admin 删别人笔记仍写 deletedByUserId (审计 + 通知), 但路径不再依赖 deletedInGroupId.
// ?groupId= 仍可选传 (audit 记录哪个群上下文发起), 不影响进哪个回收站
app.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id'); // 多设备同步: 给 publish 让其他设备 SSE 跳过自己发的事件
  const { id } = c.req.param();
  const groupIdQuery = c.req.query('groupId');

  // 扩到群 admin 可删共享笔记 (普通成员有 write 权限也不能删, 删除是管理操作)
  const existing = await getNoteForAccess(userId, id, 'read');
  if (!existing) return c.json({ error: '笔记不存在' }, 404);
  const isAuthor = existing.userId === userId;
  if (!isAuthor) {
    if (existing.visibility !== 'shared' || !(await isAdminOfSharedNote(userId, id))) {
      return c.json({ error: '只有作者或群管理员可以删除' }, 403);
    }
  }

  // 拉 sharedGroupIds 给前端 (操作者自己的 GroupDetail 用本地 ref 自管, 收不到 SSE)
  let sharedGroupIds: string[] = [];
  if (existing.visibility === 'shared') {
    const shares = await db.select({ groupId: schema.noteShares.groupId })
      .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).all();
    sharedGroupIds = shares.map(s => s.groupId);
  }

  // 内容快照 (审计 + 7 天内回收站恢复用. 7 天后永久删时快照仍留 audit_logs)
  const snapshot = {
    content: existing.content,
    tags: existing.tags,
    category: existing.category,
    type: existing.type,
    visibility: existing.visibility,
  };

  await db.update(schema.notes)
    .set({
      deletedAt: dayjs().toISOString(),
      // admin 删别人时写 deletedByUserId 审计 + 通知用; 作者删自己不写 (deletedByUserId=NULL 表示作者本人删)
      // deletedInGroupId 写一下 groupIdQuery 当审计标记 (新设计不依赖此字段做业务判断, 但留作"操作发起群"记录)
      ...(!isAuthor ? { deletedByUserId: userId } : {}),
      ...(groupIdQuery && sharedGroupIds.includes(groupIdQuery) ? { deletedInGroupId: groupIdQuery } : {}),
    })
    .where(eq(schema.notes.id, id));

  // 软删共享笔记 → 通知群成员 (note_shares 保留但 deletedAt 过滤让 feed 看不到)
  if (existing.visibility === 'shared' && sharedGroupIds.length > 0) {
    broadcastNoteShared(sharedGroupIds, userId, _ocid).catch(e => console.error('[notes] broadcast failed:', e));
  }
  // 多设备同步: 作者本人所有设备主 view 移除该 id
  publish(userId, 'note-deleted', { noteId: id }, _ocid);

  // 任何人删共享笔记都给所有相关群 owner+admin 发 group-trash-changed 让群回收站 view 刷
  if (existing.visibility === 'shared' && sharedGroupIds.length > 0) {
    const admins = await db.select({ userId: schema.groupMembers.userId, groupId: schema.groupMembers.groupId })
      .from(schema.groupMembers)
      .where(and(
        inArray(schema.groupMembers.groupId, sharedGroupIds),
        eq(schema.groupMembers.status, 'active'),
        sql`${schema.groupMembers.role} IN ('owner', 'admin')`,
      )).all();
    const seen = new Set<string>();
    for (const a of admins) {
      const k = a.userId + '|' + a.groupId;
      if (seen.has(k)) continue;
      seen.add(k);
      publish(a.userId, 'group-trash-changed', { groupId: a.groupId }, _ocid);
    }
  }

  // admin 删别人笔记 → 通知作者. 只在非作者删时发, 作者删自己不通知自己
  if (!isAuthor && sharedGroupIds.length > 0) {
    // 通知 body 提哪个群: 优先 groupIdQuery (前端从上下文传的), fallback 第一个共享群
    const notifyGroupId = (groupIdQuery && sharedGroupIds.includes(groupIdQuery)) ? groupIdQuery : sharedGroupIds[0];
    const [group, actor] = await Promise.all([
      db.select({ name: schema.groups.name }).from(schema.groups).where(eq(schema.groups.id, notifyGroupId)).get(),
      db.select({ nickname: schema.users.nickname }).from(schema.users).where(eq(schema.users.id, userId)).get(),
    ]);
    await createNotification(
      existing.userId, 'content', 'note-deleted-by-admin',
      '你的笔记被管理员删除',
      `${actor?.nickname || '管理员'}在「${group?.name || '群组'}」删除了你的笔记: ${noteSnippet(existing.content)}`,
      { noteId: id, groupId: notifyGroupId, deletedByUserId: userId },
    );
  }

  await logAudit(c, isAuthor ? 'note.delete' : 'note.delete_by_admin', 'note', id, {
    visibility: existing.visibility, sharedGroupIds, isAuthor, groupIdQuery, snapshot,
  });
  return c.json({ message: '已移入回收站', sharedGroupIds });
});

/**
 * 异步 AI 处理：自动标签 + 自动分类
 * 不阻塞笔记保存，后台静默执行
 * 巨型 content 跳过 AI 处理防大账单
 */
async function processNoteWithAi(userId: string, noteId: string, content: string, existingTags: string[], opts?: { simplifyContent?: boolean; originClientId?: string }) {
  try {
    if (content.length > NOTE_AI_SKIP_THRESHOLD) {
      await db.update(schema.notes).set({ aiProcessed: true }).where(eq(schema.notes.id, noteId));
      console.log(`[AI] Note ${noteId}: skipped (content too large: ${content.length} chars)`);
      return;
    }
    // 读用户偏好:自动标签 / 自动摘要 开关 + 摘要最小字符数
    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    const prefs = (user as any)?.preferences || {};
    const tagEnabled = prefs.autoTag !== false;
    const summaryEnabled = prefs.autoSummary !== false;
    const categorizeEnabled = prefs.autoCategorize !== false;
    const summaryMinLen = prefs.autoSummaryMinLen || 200;

    // 摘要长度判断: 排除图片/音频/视频/文档等附件 markdown,只看纯文字长度.
    // 否则"只贴一张图"的笔记 content.length 很大但实际文字 0,触发 AI 摘要后 AI
    // 回报"无法生成摘要 请提供文本内容"或"内容为空或无法识别"
    const plainTextLen = content
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // 图片 ![alt](url)
      .replace(/\[[^\]]*\]\([^)]+\.(?:png|jpg|jpeg|gif|webp|svg|webm|mp3|wav|ogg|m4a|mp4|mov|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|txt|md|csv|json)\)/gi, '') // 附件链接
      .trim().length;

    // 纯附件笔记 (音频/图片/视频/文档, plainTextLen=0) 跳过 AI 标签 + 分类:
    // content 只是 [语音备忘 30s](xxx.m4a) 这类 markdown 时, AI 会从文件名 / 时间戳里抽
    // "语音备忘" / 日期 / 文件名当垃圾标签. 阈值 5 跟 autoTag 内部 cleanContent < 5
    // 跳过门槛对齐, 但用 plainTextLen 度量 (剥过附件 markdown), 让真正的纯附件笔记被拦下.
    const TAG_MIN_PLAIN_LEN = 5;
    // float「AI整理」: 后台精简 content (仅 simplifyContent=true 时跑, 否则不碰 content; autoSimplify 内部判太短)
    const simplifyEnabled = opts?.simplifyContent === true;
    const [tags, category, summary, simplified] = await Promise.all([
      // 用户已自己写了标签 → 直接用; 关了自动标签 / 纯附件笔记 → 留空; 否则 AI 生成
      existingTags.length > 0 ? Promise.resolve(existingTags) : (tagEnabled && plainTextLen >= TAG_MIN_PLAIN_LEN ? autoTag(userId, content) : Promise.resolve([] as string[])),
      categorizeEnabled && plainTextLen >= TAG_MIN_PLAIN_LEN ? autoClassify(userId, content) : Promise.resolve(null),
      summaryEnabled && plainTextLen >= summaryMinLen ? autoSummary(userId, content) : Promise.resolve(null),
      simplifyEnabled ? autoSimplify(userId, content) : Promise.resolve(null),
    ]);

    // AI 异步回填可能跟用户立即 PATCH 撞 race. 仅在原值仍为 null/空时回填,
    // 防 AI 返回值覆盖用户手动改的字段 (用户改 tags=['foo'], AI 同时返回 ['bar'] → 不能盖)
    const fresh = await db.select().from(schema.notes).where(eq(schema.notes.id, noteId)).get();
    if (!fresh) return; // 笔记被删了, 静默退出
    const updates: Record<string, any> = { aiProcessed: true };
    const freshTags = (fresh.tags as string[]) || [];
    if (tags.length > 0 && existingTags.length === 0 && freshTags.length === 0) {
      updates.tags = tags;
    }
    // 不再"AI 返回新分类就自动 insert". autoClassify 已经在内部用 {categories} 限定 + 校验,
    // 返回值要么在 categories 表里要么是 null. category 表只在注册 seed / 用户手动添加时增长.
    if (category && !fresh.category) updates.category = category;
    if (summary && !fresh.summary) updates.summary = summary;
    // 精简结果直接覆盖 content (float「AI整理」语义就是精简后存). content 变了搜索索引 contentPinyin 也要跟着更新.
    if (simplified) {
      updates.content = simplified;
      updates.contentPinyin = toPinyinSearchable(simplified);
    }

    await db.update(schema.notes).set(updates).where(eq(schema.notes.id, noteId));
    // 精简改了 content 必须 publish note-updated: float 是独立窗口存完即关, 主窗口靠 note-created 插入原文卡片
    // 但不会自己轮询这条 (syncNoteCreated 只插入不轮询), 只有这条 SSE 能让主窗口 refreshSingleNote 回填精简版
    if (simplified) publish(userId, 'note-updated', { noteId }, opts?.originClientId);
    console.log(`[AI] Note ${noteId}: tags=${JSON.stringify(tags)}, category=${category}, summary=${summary}, simplified=${!!simplified}`);
  } catch (err) {
    console.error(`[AI] Failed to process note ${noteId}:`, err);
  }
}

// =========================================================
//  提醒分家: 个人提醒 + 群提醒
// =========================================================
// 个人提醒: 任何 read 权限用户都能设 (自己或别人共享的笔记). UNIQUE (user, note) 自动覆盖旧值.
// 群提醒: 群 owner/admin 对群内 shared 笔记设 (笔记必须 share 到指定 group_id). UNIQUE (note, group).
// 旧 notes.todo_due 不再由这些 endpoint 写, PATCH /:id 加 shim 同步双写到 personal_reminder 保持兼容
const reminderSchema = z.object({
  dueAt: z.string().min(1).max(64),
  rrule: z.string().max(512).nullable().optional(),
});
const groupReminderSchema = reminderSchema.extend({
  groupId: z.string().min(1).max(32),
});

// POST /api/notes/:id/personal-reminder — 设/更新个人提醒
app.post('/:id/personal-reminder', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  const parsed = reminderSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const now = dayjs().toISOString();
  await db.insert(schema.notePersonalReminders).values({
    id: nanoid(12),
    userId,
    noteId: id,
    dueAt: parsed.data.dueAt,
    rrule: parsed.data.rrule ?? null,
    remindSentAt: null,
    createdAt: now,
  }).onConflictDoUpdate({
    target: [schema.notePersonalReminders.userId, schema.notePersonalReminders.noteId],
    set: { dueAt: parsed.data.dueAt, rrule: parsed.data.rrule ?? null, remindSentAt: null },
  });
  publish(userId, 'data-changed', { scope: 'reminders', noteId: id }, _ocid);
  await logAudit(c, 'note.personal_reminder_set', 'note', id, { dueAt: parsed.data.dueAt, rrule: parsed.data.rrule });
  return c.json({ data: { noteId: id, dueAt: parsed.data.dueAt, rrule: parsed.data.rrule ?? null } });
});

// DELETE /api/notes/:id/personal-reminder — 删个人提醒 (idempotent)
app.delete('/:id/personal-reminder', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  await db.delete(schema.notePersonalReminders).where(and(
    eq(schema.notePersonalReminders.userId, userId),
    eq(schema.notePersonalReminders.noteId, id),
  ));
  publish(userId, 'data-changed', { scope: 'reminders', noteId: id }, _ocid);
  await logAudit(c, 'note.personal_reminder_delete', 'note', id);
  return c.json({ message: '已删除' });
});

// POST /api/notes/:id/group-reminder — 设/更新群提醒. body { groupId, dueAt, rrule? }
// 校验: 1) note 分享到 groupId 2) userId 在 groupId 是 owner/admin
app.post('/:id/group-reminder', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  const parsed = groupReminderSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { groupId, dueAt, rrule } = parsed.data;
  const note = await db.select().from(schema.notes).where(eq(schema.notes.id, id)).get();
  if (!note || note.deletedAt) return c.json({ error: '笔记不存在' }, 404);
  if (note.visibility !== 'shared') return c.json({ error: '私有笔记不支持群提醒' }, 400);
  const share = await db.select({ noteId: schema.noteShares.noteId }).from(schema.noteShares)
    .where(and(eq(schema.noteShares.noteId, id), eq(schema.noteShares.groupId, groupId))).get();
  if (!share) return c.json({ error: '该笔记未分享到此群' }, 400);
  const me = await db.select({ role: schema.groupMembers.role }).from(schema.groupMembers)
    .where(and(
      eq(schema.groupMembers.groupId, groupId),
      eq(schema.groupMembers.userId, userId),
      eq(schema.groupMembers.status, 'active'),
    )).get();
  if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
    return c.json({ error: '仅群主或管理员可设群提醒' }, 403);
  }
  const now = dayjs().toISOString();
  await db.insert(schema.noteGroupReminders).values({
    id: nanoid(12),
    noteId: id,
    groupId,
    dueAt,
    rrule: rrule ?? null,
    remindSentAt: null,
    createdBy: userId,
    createdAt: now,
  }).onConflictDoUpdate({
    target: [schema.noteGroupReminders.noteId, schema.noteGroupReminders.groupId],
    set: { dueAt, rrule: rrule ?? null, remindSentAt: null, createdBy: userId },
  });
  publish(userId, 'data-changed', { scope: 'reminders', noteId: id, groupId }, _ocid);
  // 设/更新群提醒时给该群 active 成员 (除发起人) 发通知, 跟 scheduler 到点同款规则:
  // group_reminder_subscriptions.enabled=false 的成员一律跳过 (用户已明示"不想被该群打扰", 设置事件也算"打扰")
  const members = await db.select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(and(
      eq(schema.groupMembers.groupId, groupId),
      eq(schema.groupMembers.status, 'active'),
    )).all();
  // 移除群级开关过滤, 仅保留卡片级 mute. 群级"接收本群通知"开关已废
  const memberIds = members.map(m => m.userId);
  const mutes = memberIds.length === 0 ? [] : await db.select({ userId: schema.noteGroupReminderMutes.userId })
    .from(schema.noteGroupReminderMutes).where(and(
      eq(schema.noteGroupReminderMutes.noteId, id),
      inArray(schema.noteGroupReminderMutes.userId, memberIds),
    )).all();
  const mutedSet = new Set(mutes.map(m => m.userId));
  const recipients = memberIds.filter(uid => uid !== userId && !mutedSet.has(uid));
  const [group, actor] = await Promise.all([
    db.select({ name: schema.groups.name }).from(schema.groups).where(eq(schema.groups.id, groupId)).get(),
    db.select({ nickname: schema.users.nickname }).from(schema.users).where(eq(schema.users.id, userId)).get(),
  ]);
  const dueLabel = dayjs(dueAt).format('YYYY-MM-DD HH:mm');
  const preview = noteSnippet(note.content);
  await Promise.all(recipients.map(uid => createNotification(
    uid, 'reminder', 'group-reminder-set',
    `「${group?.name || '群组'}」多了一条群提醒`,
    `${actor?.nickname || '管理员'}设置了「${preview}」的群提醒, 到点 ${dueLabel} 提醒大家`,
    { noteId: id, groupId, dueAt, rrule: rrule ?? null, createdByUserId: userId },
  )));
  await logAudit(c, 'note.group_reminder_set', 'note', id, { groupId, dueAt, rrule, notifiedMembers: recipients.length });
  return c.json({ data: { noteId: id, groupId, dueAt, rrule: rrule ?? null } });
});

// DELETE /api/notes/:id/group-reminder?groupId= — 删群提醒
app.delete('/:id/group-reminder', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  const groupId = c.req.query('groupId');
  if (!groupId) return c.json({ error: 'groupId 缺失' }, 400);
  const me = await db.select({ role: schema.groupMembers.role }).from(schema.groupMembers)
    .where(and(
      eq(schema.groupMembers.groupId, groupId),
      eq(schema.groupMembers.userId, userId),
      eq(schema.groupMembers.status, 'active'),
    )).get();
  if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
    return c.json({ error: '仅群主或管理员可删群提醒' }, 403);
  }
  await db.delete(schema.noteGroupReminders).where(and(
    eq(schema.noteGroupReminders.noteId, id),
    eq(schema.noteGroupReminders.groupId, groupId),
  ));
  publish(userId, 'data-changed', { scope: 'reminders', noteId: id, groupId }, _ocid);
  await logAudit(c, 'note.group_reminder_delete', 'note', id, { groupId });
  return c.json({ message: '已删除' });
});

// GET /api/notes/:id/reminders — 拉某笔记我可见的所有提醒 (我的个人 + 我所在群的群提醒)
// 用于 NoteCard 显示提醒铃铛 + 设提醒 modal 回填
app.get('/:id/reminders', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  const personal = await db.select().from(schema.notePersonalReminders)
    .where(and(
      eq(schema.notePersonalReminders.userId, userId),
      eq(schema.notePersonalReminders.noteId, id),
    )).get();
  // 我所在 active 群 ∩ 笔记分享群 (跟 noteShares.note_shares 交集)
  const myGroupIds = (await db.select({ groupId: schema.groupMembers.groupId })
    .from(schema.groupMembers).where(and(
      eq(schema.groupMembers.userId, userId),
      eq(schema.groupMembers.status, 'active'),
    )).all()).map(g => g.groupId);
  const groupReminders = myGroupIds.length === 0 ? [] : await db.select()
    .from(schema.noteGroupReminders)
    .where(and(
      eq(schema.noteGroupReminders.noteId, id),
      inArray(schema.noteGroupReminders.groupId, myGroupIds),
    )).all();
  // 卡片级 mute 状态 (该用户对这条笔记是否屏蔽群提醒). 给 NoteCard 铃铛斜杠图标 + 菜单文案切换用
  const muteRow = await db.select({ noteId: schema.noteGroupReminderMutes.noteId })
    .from(schema.noteGroupReminderMutes).where(and(
      eq(schema.noteGroupReminderMutes.userId, userId),
      eq(schema.noteGroupReminderMutes.noteId, id),
    )).get();
  return c.json({ data: { personal: personal ?? null, group: groupReminders, muted: !!muteRow } });
});

// POST /api/notes/:id/group-reminder/mute — 屏蔽本笔记群提醒 (跨所有 share 群生效, 仅影响调用者本人)
// 比群级 group_reminder_subscriptions 更细粒度, 用户对单条待办说"不打扰我"
app.post('/:id/group-reminder/mute', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  // 校验笔记可见 (防屏蔽不属于自己可访问的笔记)
  const note = await getNoteForAccess(userId, id, 'read');
  if (!note) return c.json({ error: '笔记不存在' }, 404);
  await db.insert(schema.noteGroupReminderMutes).values({
    userId, noteId: id, mutedAt: dayjs().toISOString(),
  }).onConflictDoNothing();
  publish(userId, 'data-changed', { scope: 'reminders', noteId: id }, _ocid);
  await logAudit(c, 'note.group_reminder_mute', 'note', id, {});
  return c.json({ message: '已屏蔽' });
});

// DELETE /api/notes/:id/group-reminder/mute — 取消屏蔽
app.delete('/:id/group-reminder/mute', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  await db.delete(schema.noteGroupReminderMutes).where(and(
    eq(schema.noteGroupReminderMutes.userId, userId),
    eq(schema.noteGroupReminderMutes.noteId, id),
  ));
  publish(userId, 'data-changed', { scope: 'reminders', noteId: id }, _ocid);
  await logAudit(c, 'note.group_reminder_unmute', 'note', id, {});
  return c.json({ message: '已恢复接收' });
});

export default app;
