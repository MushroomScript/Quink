import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, desc, like, or, and, sql, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import { authMiddleware } from '../auth.js';
import { autoTag, autoClassify, autoSummary } from '../ai/client.js';
import { toPinyinSearchable } from '../utils/pinyin.js';
import { publish } from '../reminder/bus.js';

const app = new Hono();

// 所有笔记路由都需要登录
app.use('*', authMiddleware);

const createNoteSchema = z.object({
  content: z.string().min(1),
  type: z.enum(['note', 'todo', 'snippet', 'link']).default('note'),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  todoDue: z.string().optional(), // ISO datetime, 复用为提醒时间
  todoRemindRrule: z.string().nullable().optional(), // RFC 5545 RRULE
  // PR #2 群组共享: visibility=private (默认, 仅作者) / visibility=shared 必须给 sharedGroupIds[]
  visibility: z.enum(['private', 'shared']).default('private'),
  sharedGroupIds: z.array(z.string()).optional(),
});

const updateNoteSchema = z.object({
  content: z.string().min(1).optional(),
  summary: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  type: z.enum(['note', 'todo', 'snippet', 'link']).optional(),
  todoStatus: z.enum(['pending', 'done']).optional(),
  todoDue: z.string().nullable().optional(),
  todoRemindRrule: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
  // PR #2: 改可见性 / 重写分享群列表. sharedGroupIds 传值时整批替换 (delete all + insert new)
  visibility: z.enum(['private', 'shared']).optional(),
  sharedGroupIds: z.array(z.string()).optional(),
  // PR #5: 编辑共享笔记必须带 lockToken (POST /lock 拿) + version (乐观锁). 私有笔记不需要.
  lockToken: z.string().optional(),
  version: z.number().int().positive().optional(),
  // PR #5b: 改编辑权限, 仅作者能改 (非作者传 → 403)
  editPermission: z.enum(['admin', 'all']).optional(),
});

// PR #2 阶段 5c: 广播 'group-notes-changed' 给目标群所有 active 成员 (除操作者).
// POST/PATCH 共享笔记 / 永久删除 共享笔记时调用, 前端在群详情页时自动 reload group feed
async function broadcastNoteShared(groupIds: string[], exceptUserId: string) {
  if (groupIds.length === 0) return;
  const members = await db.select({ userId: schema.groupMembers.userId, groupId: schema.groupMembers.groupId })
    .from(schema.groupMembers)
    .where(and(
      inArray(schema.groupMembers.groupId, groupIds),
      eq(schema.groupMembers.status, 'active'),
    )).all();
  // dedup userId+groupId, 一个用户在多个目标群里也只一条事件
  const seen = new Set<string>();
  for (const m of members) {
    if (m.userId === exceptUserId) continue;
    const key = m.userId + '|' + m.groupId;
    if (seen.has(key)) continue;
    seen.add(key);
    publish(m.userId, 'group-notes-changed', { groupId: m.groupId });
  }
}

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
  const { search, category, type, tag, tags, types, dateFrom, dateTo, sort, scope = 'mine', page = '1', limit = '50' } = c.req.query();
  const offset = (parseInt(page) - 1) * parseInt(limit);
  // 排序字段: created (默认, 兼容老行为) / updated. 未知值兜底 createdAt 不报错.
  const sortColumn = sort === 'updated' ? schema.notes.updatedAt : schema.notes.createdAt;

  // PR #2 scope 三种: mine (默认, 只我自己的笔记) / shared (我所在群里别人共享给我的) / group:<id> (某群可见笔记)
  const conditions: any[] = [
    sql`${schema.notes.deletedAt} IS NULL`, // 排除回收站
  ];
  if (scope === 'mine') {
    conditions.push(eq(schema.notes.userId, userId));
  } else if (scope === 'shared') {
    // 子查询: id IN (note_shares WHERE group_id IN my_active_groups) AND author != me
    conditions.push(sql`${schema.notes.id} IN (
      SELECT ns.note_id FROM note_shares ns
      WHERE ns.group_id IN (
        SELECT group_id FROM group_members WHERE user_id = ${userId} AND status = 'active'
      )
    )`);
    conditions.push(sql`${schema.notes.userId} != ${userId}`);
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
    return c.json({ error: '无效的 scope, 应为 mine / shared / group:<id>' }, 400);
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
  if (category) {
    conditions.push(like(schema.notes.category, `${category}%`));
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

  // PR #2 阶段 4: 拼 sharedGroupIds (我的 shared 笔记 NoteCard 显示 "N 群" chip 用) +
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
    // scope!=mine 时多查 author info (mine scope 作者就是自己, 前端 auth.user 已知)
    let authorMap: Map<string, { nickname: string; avatar: string | null }> | null = null;
    if (scope !== 'mine') {
      const authorIds = [...new Set(results.map(n => n.userId))];
      const authors = await db.select({ id: schema.users.id, nickname: schema.users.nickname, avatar: schema.users.avatar })
        .from(schema.users)
        .where(inArray(schema.users.id, authorIds))
        .all();
      authorMap = new Map(authors.map(u => [u.id, { nickname: u.nickname, avatar: u.avatar }]));
    }
    data = results.map(n => {
      const enriched: any = { ...n, sharedGroupIds: sharesMap.get(n.id) || [] };
      if (authorMap) {
        const a = authorMap.get(n.userId);
        enriched.authorNickname = a?.nickname ?? null;
        enriched.authorAvatar = a?.avatar ?? null;
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
  const results = await db.select().from(schema.notes)
    .where(and(eq(schema.notes.userId, userId), sql`${schema.notes.deletedAt} IS NOT NULL`))
    .orderBy(desc(schema.notes.deletedAt))
    .all();
  // PR #2: 拼 sharedGroupIds 让 Trash 删除确认窗显示 "已分享到 N 群组"
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
  const { id } = c.req.param();
  const existing = await db.select().from(schema.notes)
    .where(and(eq(schema.notes.id, id), eq(schema.notes.userId, userId))).get();
  if (!existing || !existing.deletedAt) return c.json({ error: '笔记不存在' }, 404);
  await db.update(schema.notes).set({ deletedAt: null }).where(eq(schema.notes.id, id));
  return c.json({ message: '已恢复' });
});

// DELETE /api/notes/trash/:id
app.delete('/trash/:id', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  // PR #2: 永久删除事务清 note_shares (防 FK constraint 阻 delete notes)
  db.transaction((tx) => {
    tx.delete(schema.noteShares).where(eq(schema.noteShares.noteId, id)).run();
    tx.delete(schema.notes).where(and(eq(schema.notes.id, id), eq(schema.notes.userId, userId))).run();
  });
  return c.json({ message: '已永久删除' });
});

// DELETE /api/notes/trash — 清空
app.delete('/trash', async (c) => {
  const userId = c.get('userId');
  // PR #2: 先拿要删的 noteIds 清 note_shares, 再删 notes (单 DELETE 包 subquery 也能但事务更清晰)
  const trashed = await db.select({ id: schema.notes.id }).from(schema.notes)
    .where(and(eq(schema.notes.userId, userId), sql`${schema.notes.deletedAt} IS NOT NULL`))
    .all();
  if (trashed.length === 0) return c.json({ message: '已清空' });
  const ids = trashed.map(t => t.id);
  db.transaction((tx) => {
    tx.delete(schema.noteShares).where(inArray(schema.noteShares.noteId, ids)).run();
    tx.delete(schema.notes).where(and(eq(schema.notes.userId, userId), sql`${schema.notes.deletedAt} IS NOT NULL`)).run();
  });
  return c.json({ message: '已清空' });
});

// GET /api/notes/tags（必须在 /:id 之前注册）
app.get('/tags', async (c) => {
  const userId = c.get('userId');
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

// PR #5 / 5b helper: 校验 userId 能否访问 noteId. 作者本人永远放行; 否则必须 visibility='shared' + 我是 note_shares 关联群 active member.
// mode='read' (默认) 只校验可见; mode='write' 加 PR #5b editPermission 校验:
//   editPermission='all' → 所有 active member 都能改
//   editPermission='admin' → 必须我在共享群里是 owner/admin
//   都不满足 → 查 note_edit_grants 白名单, 在内则放行 (申请编辑权通过后写入)
// 返回 note 或 null. lock API + PATCH + DELETE + chat update_note 都用这函数.
type AccessMode = 'read' | 'write';
async function getNoteForAccess(userId: string, noteId: string, mode: AccessMode = 'read'): Promise<typeof schema.notes.$inferSelect | null> {
  const note = await db.select().from(schema.notes).where(eq(schema.notes.id, noteId)).get();
  if (!note) return null;
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
  // write 模式: PR #5b editPermission 三档校验
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

// PR #5b helper: 校验 userId 在某 shared 笔记关联的群里是 owner/admin. 给 DELETE / 审批申请等
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

// PR #5 编辑锁: 5 分钟 TTL + 30s 前端心跳续约 + sendBeacon 离开释放 + cron 60s 兜底清过期.
// 仅 shared 笔记走锁逻辑 (private 笔记不需协作, lock API 调用会 400).
const LOCK_TTL_MS = 5 * 60 * 1000;

// POST /api/notes/:id/lock — 申请编辑锁. 别人持锁未过期 → 409 带 lockByNickname + expiresAt
app.post('/:id/lock', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  // PR #5b: 用 write mode 校验 - 没编辑权连锁都拿不到, 避免编辑到一半提交才发现没权 (体验差)
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

  const expiresAt = now.add(LOCK_TTL_MS, 'ms').toISOString();
  await db.update(schema.notes).set({ editLockExpiresAt: expiresAt })
    .where(eq(schema.notes.id, id));
  return c.json({ data: { expiresAt } });
});

// DELETE /api/notes/:id/lock — 释放 (前端 onBeforeUnmount + sendBeacon 调). sendBeacon 无 body 也兼容, 看 lock_by 是否我.
app.delete('/:id/lock', async (c) => {
  const userId = c.get('userId');
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

// PR #5 cron: 60s 扫一次清过期锁. 兜底 case: 用户没 sendBeacon (浏览器异常关 / 断电), 锁自然过期但 lock_by 留着.
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

// PR #5b helper: 给某笔记的"权限审批 / SSE 通知"收件人 = 作者 + 所有共享群的 owner/admin user ids (dedup)
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

// PR #5b 编辑权限申请 API (5 个): 申请 / 同意 / 拒绝 / 列待审申请 / 撤销已授权
// 改 editPermission 走 PATCH /:id 的 editPermission 字段, 不另外加 API. 跟 visibility / sharedGroupIds 同款约定 (仅作者改).

// POST /api/notes/:id/edit-request - 申请编辑权 (没 write 权的群成员调). 已 pending 返原 request (idempotent).
app.post('/:id/edit-request', async (c) => {
  const userId = c.get('userId');
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

  const reqId = nanoid(12);
  const now = dayjs().toISOString();
  const newReq: schema.NewNoteEditRequest = {
    id: reqId, noteId: id, userId, status: 'pending', message,
    createdAt: now, handledAt: null, handledBy: null,
  };
  await db.insert(schema.noteEditRequests).values(newReq);

  // SSE 推作者 + 群 admin (除申请人自己)
  const requester = await db.select({ nickname: schema.users.nickname })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  const recipients = await getNoteAuthorityRecipients(id);
  for (const rid of recipients) {
    if (rid === userId) continue;
    publish(rid, 'note-edit-request', {
      requestId: reqId, noteId: id, noteUserId: note.userId,
      requesterId: userId, requesterNickname: requester?.nickname || '群成员', message,
    });
  }
  return c.json({ data: newReq }, 201);
});

// POST /api/notes/:id/edit-requests/:reqId/approve - 同意 (作者+群 admin), 永久授权 (写 note_edit_grants)
app.post('/:id/edit-requests/:reqId/approve', async (c) => {
  const userId = c.get('userId');
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
  });
  return c.json({ data: { message: '已同意, 申请人已获得永久编辑权' } });
});

// POST /api/notes/:id/edit-requests/:reqId/reject - 拒绝 (作者+群 admin)
app.post('/:id/edit-requests/:reqId/reject', async (c) => {
  const userId = c.get('userId');
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
  });
  return c.json({ data: { message: '已拒绝' } });
});

// GET /api/notes/:id/edit-requests - 列出该笔记所有申请 (按时间倒序, 含申请人 nickname/avatar)
app.get('/:id/edit-requests', async (c) => {
  const userId = c.get('userId');
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
  return c.json({ data: { message: '已撤销编辑权' } });
});

// GET /api/notes/:id
// 作者拿自己的笔记 → 直接返回 (含 sharedGroupIds 给编辑器恢复)
// 群成员拿别人共享笔记 → 校验 note_shares 跟我所在群有交集才放行
app.get('/:id', async (c) => {
  const userId = c.get('userId');
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
  return c.json({ data: { ...note, sharedGroupIds: shares.map(s => s.groupId) } });
});

// POST /api/notes
app.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = createNoteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // PR #2 visibility 校验: shared 必须给非空 sharedGroupIds + 全是我所在的群; private 不能带 sharedGroupIds
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
    todoDue: parsed.data.todoDue ?? null,
    todoRemindRrule: parsed.data.todoRemindRrule ?? null,
    todoRemindSentAt: null,
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

  // 异步 AI 处理（不阻塞响应）
  processNoteWithAi(userId, note.id, note.content, note.tags as string[]).catch(() => {});
  // PR #2 阶段 5c: 通知目标群成员有新笔记 (前端 sse handler 收到后在群详情页 reload feed)
  broadcastNoteShared(sharedGroupIds, userId).catch(e => console.error('[notes] broadcast failed:', e));

  return c.json({ data: { ...note, sharedGroupIds } }, 201);
});

// PATCH /api/notes/:id
app.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  const body = await c.req.json();
  const parsed = updateNoteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // PR #5: 鉴权扩到 shared 笔记的群成员; PR #5b: 加 write mode 校验 editPermission
  const existing = await getNoteForAccess(userId, id, 'read');
  if (!existing) return c.json({ error: '笔记不存在' }, 404);

  const isAuthor = existing.userId === userId;
  const data = parsed.data;

  // PR #5b: 非作者 + shared 笔记 → 检查 write 权限 (editPermission + grants 白名单)
  if (!isAuthor && existing.visibility === 'shared') {
    const writable = await getNoteForAccess(userId, id, 'write');
    if (!writable) {
      return c.json({
        error: 'no_write_permission',
        editPermission: existing.editPermission,
      }, 403);
    }
  }

  // PR #5: 非作者编辑共享笔记 → 禁止改 visibility / sharedGroupIds / editPermission (这些是分享设置, 仅作者控)
  if (!isAuthor && (data.visibility !== undefined || data.sharedGroupIds !== undefined || data.editPermission !== undefined)) {
    return c.json({ error: '只有作者可以修改共享设置' }, 403);
  }

  const updates: Record<string, any> = { updatedAt: dayjs().toISOString() };

  // PR #5: shared 笔记必须持锁 + version 校验. private 笔记保持原行为 (作者直接改, 不需锁)
  // PR #5b: 作者本人改自己的共享笔记也不需要锁 (改 editPermission / visibility / 内容都是"管理自己东西", 无冲突).
  // 锁主要防"群成员协作时撞改". 作者多设备同步靠 version 乐观锁兜底
  if (existing.visibility === 'shared' && !isAuthor) {
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
  // 改 todoDue 视作"重新设提醒", 必须把 sent_at 重置, 否则 scheduler 看 sent_at 不为 null 会跳过
  if (data.todoDue !== undefined) {
    updates.todoDue = data.todoDue;
    updates.todoRemindSentAt = null;
  }
  if (data.todoRemindRrule !== undefined) updates.todoRemindRrule = data.todoRemindRrule;
  if (data.pinned !== undefined) updates.pinned = data.pinned;
  // PR #5b: 改编辑权限. 仅作者能改 (上面已校验非作者传过来直接 403)
  if (data.editPermission !== undefined) updates.editPermission = data.editPermission;
  // PR #2 改 visibility / sharedGroupIds: 校验后整批替换 note_shares (delete all + insert new)
  // 客户端可以三种方式调: 仅传 visibility (改私密性) / 仅传 sharedGroupIds (改群列表) / 两个一起
  const willUpdateShares = data.visibility !== undefined || data.sharedGroupIds !== undefined;
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
    if (newSharedGroupIds && newSharedGroupIds.length > 0) {
      const err = await validateSharedGroups(userId, newSharedGroupIds);
      if (err) return c.json({ error: err }, 403);
    }
    if (data.visibility !== undefined) updates.visibility = data.visibility;
  }

  // PR #2 阶段 5c: 拿 PATCH 前的旧 sharedGroupIds 做差异广播 (旧群通知"被取消", 新群通知"新增")
  let oldGroupIds: string[] = [];
  if (willUpdateShares) {
    const oldShares = await db.select({ groupId: schema.noteShares.groupId })
      .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).all();
    oldGroupIds = oldShares.map(s => s.groupId);
  }

  // 事务: notes update + note_shares 整批替换 一起跑, 防写一半留脏数据
  const now = updates.updatedAt as string;
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
  });

  // PR #2 阶段 5c: 广播给 旧 ∪ 新 groupIds 的成员 (旧群刷掉这条笔记, 新群加上这条笔记 / 内容改了也要同步)
  if (willUpdateShares) {
    const allGroupIds = [...new Set([...oldGroupIds, ...(newSharedGroupIds || [])])];
    broadcastNoteShared(allGroupIds, userId).catch(e => console.error('[notes] broadcast failed:', e));
  } else if (existing.visibility === 'shared') {
    // 只改了内容/tag 没改群列表, 但已经是 shared → 通知所有群成员刷新看新内容
    const shares = await db.select({ groupId: schema.noteShares.groupId })
      .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).all();
    broadcastNoteShared(shares.map(s => s.groupId), userId).catch(e => console.error('[notes] broadcast failed:', e));
  }

  const updated = await db.select().from(schema.notes).where(eq(schema.notes.id, id)).get();
  // 返回 sharedGroupIds 让前端拿到当前最新分享列表
  const shares = await db.select({ groupId: schema.noteShares.groupId })
    .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).all();
  return c.json({ data: { ...updated, sharedGroupIds: shares.map(s => s.groupId) } });
});

// DELETE /api/notes/:id — 软删除（移入回收站）
app.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();

  // PR #5b: 扩到群 admin 可删共享笔记 (普通成员有 write 权限也不能删, 删除是管理操作)
  const existing = await getNoteForAccess(userId, id, 'read');
  if (!existing) return c.json({ error: '笔记不存在' }, 404);
  const isAuthor = existing.userId === userId;
  if (!isAuthor) {
    if (existing.visibility !== 'shared' || !(await isAdminOfSharedNote(userId, id))) {
      return c.json({ error: '只有作者或群管理员可以删除' }, 403);
    }
  }

  await db.update(schema.notes)
    .set({ deletedAt: dayjs().toISOString() })
    .where(eq(schema.notes.id, id));

  // PR #2 阶段 5c: 软删共享笔记 → 通知群成员 (note_shares 保留但 deletedAt 过滤让 feed 看不到)
  if (existing.visibility === 'shared') {
    const shares = await db.select({ groupId: schema.noteShares.groupId })
      .from(schema.noteShares).where(eq(schema.noteShares.noteId, id)).all();
    broadcastNoteShared(shares.map(s => s.groupId), userId).catch(e => console.error('[notes] broadcast failed:', e));
  }
  return c.json({ message: '已移入回收站' });
});

/**
 * 异步 AI 处理：自动标签 + 自动分类
 * 不阻塞笔记保存，后台静默执行
 */
async function processNoteWithAi(userId: string, noteId: string, content: string, existingTags: string[]) {
  try {
    // 读用户偏好:自动标签 / 自动摘要 开关 + 摘要最小字符数
    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    const prefs = (user as any)?.preferences || {};
    const tagEnabled = prefs.autoTag !== false;
    const summaryEnabled = prefs.autoSummary !== false;
    const categorizeEnabled = prefs.autoCategorize !== false;
    const summaryMinLen = prefs.autoSummaryMinLen || 200;

    // 摘要长度判断: 排除图片/音频/视频/文档等附件 markdown,只看纯文字长度.
    // 否则"只贴一张图"的笔记 content.length 很大但实际文字 0,触发 AI 摘要后 AI
    // 回报"无法生成摘要 请提供文本内容"或"内容为空或无法识别"(蘑菇汇报的 G1/G2)
    const plainTextLen = content
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // 图片 ![alt](url)
      .replace(/\[[^\]]*\]\([^)]+\.(?:png|jpg|jpeg|gif|webp|svg|webm|mp3|wav|ogg|m4a|mp4|mov|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|txt|md|csv|json)\)/gi, '') // 附件链接
      .trim().length;

    const [tags, category, summary] = await Promise.all([
      // 用户已自己写了标签 → 直接用; 关了自动标签 → 留空; 否则 AI 生成
      existingTags.length > 0 ? Promise.resolve(existingTags) : (tagEnabled ? autoTag(userId, content) : Promise.resolve([] as string[])),
      categorizeEnabled ? autoClassify(userId, content) : Promise.resolve(null),
      summaryEnabled && plainTextLen >= summaryMinLen ? autoSummary(userId, content) : Promise.resolve(null),
    ]);

    const updates: Record<string, any> = { aiProcessed: true };
    if (tags.length > 0 && existingTags.length === 0) updates.tags = tags;
    // 不再"AI 返回新分类就自动 insert" (2026-05-29). autoClassify 已经在内部用 {categories} 限定 + 校验,
    // 返回值要么在 categories 表里要么是 null. category 表只在注册 seed / 用户手动添加时增长.
    if (category) updates.category = category;
    if (summary) updates.summary = summary;

    await db.update(schema.notes).set(updates).where(eq(schema.notes.id, noteId));
    console.log(`[AI] Note ${noteId}: tags=${JSON.stringify(tags)}, category=${category}, summary=${summary}`);
  } catch (err) {
    console.error(`[AI] Failed to process note ${noteId}:`, err);
  }
}

export default app;
