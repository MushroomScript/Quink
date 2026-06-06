import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import { authMiddleware } from '../auth.js';
import { publish, isOnline } from '../reminder/bus.js';
import { loadSocialMetaMaps, loadEditorCountMap } from './notes.js';

const app = new Hono();

// 邀请 token 长度: 16 位 url-safe nanoid (entropy ~95bit, 防猜测)
const INVITE_TOKEN_LEN = 16;
// 默认邀请 token 有效期 7 天 (owner 可重置延长)
const INVITE_DEFAULT_TTL_DAYS = 7;

// ── 辅助: 校验当前用户是某群的 active member, 失败返回 null ──
async function getActiveMember(groupId: string, userId: string) {
  return db.select().from(schema.groupMembers)
    .where(and(
      eq(schema.groupMembers.groupId, groupId),
      eq(schema.groupMembers.userId, userId),
      eq(schema.groupMembers.status, 'active'),
    )).get();
}

// ── 辅助: 广播 'group-changed' 给群内所有 active 成员 (除 exceptUserIds 外).
//        触发场景: 成员变化 (加入/踢/退) / 角色变更 / 群信息修改. 前端收到自动刷新当前打开的群 + 群列表
async function broadcastGroupChanged(groupId: string, exceptUserIds: string[] = []) {
  const members = await db.select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.status, 'active')))
    .all();
  const except = new Set(exceptUserIds);
  for (const m of members) {
    if (!except.has(m.userId)) publish(m.userId, 'group-changed', { groupId });
  }
}

// ── 辅助: 把 owner_id / member_count 等聚合字段拼到 group row 上 (给前端用) ──
async function enrichGroup(groupId: string, viewerId?: string) {
  const g = await db.select().from(schema.groups).where(eq(schema.groups.id, groupId)).get();
  if (!g) return null;
  const countRow = db.select({ count: sql<number>`count(*)` })
    .from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.status, 'active')))
    .get();
  const memberCount = countRow?.count ?? 0;
  let myRole: string | null = null;
  if (viewerId) {
    const me = await getActiveMember(groupId, viewerId);
    myRole = me?.role ?? null;
  }
  // 公告作者昵称 (UI 展示"X 发布于 YYYY-MM-DD")
  let announcementUpdatedByNickname: string | null = null;
  if (g.announcementUpdatedBy) {
    const author = await db.select({ nickname: schema.users.nickname })
      .from(schema.users).where(eq(schema.users.id, g.announcementUpdatedBy)).get();
    announcementUpdatedByNickname = author?.nickname ?? null;
  }
  return { ...g, memberCount, myRole, announcementUpdatedByNickname };
}

// =========================================================
//  公开邀请页 (不需 auth)
// =========================================================

// 看邀请页: 任何人凭 token 都能看到群组名 + 头像 + 人数, 决定是否加入
const inviteApp = new Hono();
inviteApp.get('/:token', async (c) => {
  const token = c.req.param('token');
  if (!token) return c.json({ error: '邀请链接无效或已被重置' }, 404);
  const g = await db.select().from(schema.groups).where(eq(schema.groups.inviteToken, token)).get();
  if (!g || !g.inviteToken) return c.json({ error: '邀请链接无效或已被重置' }, 404);
  if (g.inviteExpiresAt && dayjs(g.inviteExpiresAt).isBefore(dayjs())) {
    return c.json({ error: '邀请链接已过期, 请联系管理员重新生成' }, 410);
  }
  const countRow = db.select({ count: sql<number>`count(*)` })
    .from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.groupId, g.id), eq(schema.groupMembers.status, 'active')))
    .get();
  return c.json({
    data: {
      id: g.id,
      name: g.name,
      avatar: g.avatar,
      memberCount: countRow?.count ?? 0,
      autoJoin: g.autoJoin,
      inviteExpiresAt: g.inviteExpiresAt,
    },
  });
});

// 申请加入: 必须 auth (只有登录用户能加群)
inviteApp.post('/:token/apply', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const token = c.req.param('token');
  if (!token) return c.json({ error: '邀请链接无效或已被重置' }, 404);
  const g = await db.select().from(schema.groups).where(eq(schema.groups.inviteToken, token)).get();
  if (!g || !g.inviteToken) return c.json({ error: '邀请链接无效或已被重置' }, 404);
  if (g.inviteExpiresAt && dayjs(g.inviteExpiresAt).isBefore(dayjs())) {
    return c.json({ error: '邀请链接已过期' }, 410);
  }
  // 已经是 active member 直接返回 OK (幂等, 防误点链接重复申请)
  const existing = await db.select().from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.groupId, g.id), eq(schema.groupMembers.userId, userId))).get();
  if (existing && existing.status === 'active') {
    return c.json({ data: { status: 'already_member', groupId: g.id } });
  }
  // 之前被踢过 / 主动退群过 (status='removed'): 重新申请强制走 pending 审批,
  // 即使群是 autoJoin 模式 — 防被踢的人在 autoJoin 群直接绕过审核重新加. 管理员同意时
  // approve 路由把 status=removed 改回 active (复用同一条 group_members 记录, 历史保留)
  const wasRemoved = existing?.status === 'removed';
  const now = dayjs().toISOString();
  // autoJoin 模式 + 没被踢过: 直接加成员
  if (g.autoJoin && !wasRemoved) {
    await db.insert(schema.groupMembers).values({
      groupId: g.id, userId, role: 'member', status: 'active', joinedAt: now,
    });
    // 通知 owner 有新成员加入 (SSE) + 广播给其他成员 (排除新加入的人, 他不需要刷新)
    publish(g.ownerId, 'group-member-joined', { groupId: g.id, userId });
    await broadcastGroupChanged(g.id, [userId, g.ownerId]);
    return c.json({ data: { status: 'joined', groupId: g.id } });
  }
  // 审批模式: 创建 pending 申请, 防同一人重复申请 (existing pending 直接复用)
  const existingReq = await db.select().from(schema.groupJoinRequests)
    .where(and(
      eq(schema.groupJoinRequests.groupId, g.id),
      eq(schema.groupJoinRequests.userId, userId),
      eq(schema.groupJoinRequests.status, 'pending'),
    )).get();
  if (existingReq) {
    return c.json({ data: { status: 'pending', requestId: existingReq.id, groupId: g.id } });
  }
  const reqRow = {
    id: nanoid(12),
    groupId: g.id,
    userId,
    status: 'pending' as const,
    inviteToken: token,
    createdAt: now,
    handledAt: null,
    handledBy: null,
  };
  await db.insert(schema.groupJoinRequests).values(reqRow);
  // SSE 推 owner: 让 owner 实时看到申请 (前端弹通知 / 角标)
  const applicant = await db.select({ nickname: schema.users.nickname, username: schema.users.username, avatar: schema.users.avatar })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  publish(g.ownerId, 'group-join-request', {
    requestId: reqRow.id,
    groupId: g.id,
    groupName: g.name,
    applicant: { id: userId, ...applicant },
  });
  return c.json({ data: { status: 'pending', requestId: reqRow.id, groupId: g.id } });
});

// =========================================================
//  需 auth 的群组路由
// =========================================================

app.use('*', authMiddleware);

const createSchema = z.object({
  name: z.string().min(1).max(50),
  avatar: z.string().optional(),
  autoJoin: z.boolean().default(false),
});

const updateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  avatar: z.string().nullable().optional(),
  autoJoin: z.boolean().optional(),
  // 群公告: markdown / 空字符串视为清空. owner + admin 都能改 (其他字段仅 owner)
  announcement: z.string().max(2000).nullable().optional(),
});

// 我的群列表: 我作为 active member 的群, 含成员数 + 我的角色
app.get('/', async (c) => {
  const userId = c.get('userId');
  // join 拿群基本信息 + 自己角色
  const rows = db.all(sql`
    SELECT g.*, gm.role as my_role,
      (SELECT count(*) FROM group_members WHERE group_id = g.id AND status = 'active') as member_count
    FROM groups g
    INNER JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ${userId} AND gm.status = 'active'
    ORDER BY g.created_at DESC
  `) as Array<{
    id: string; owner_id: string; name: string; avatar: string | null;
    invite_token: string | null; invite_expires_at: string | null; auto_join: number; created_at: string;
    my_role: string; member_count: number;
  }>;
  // snake_case → camelCase (绕开 ORM 自动映射, raw SQL 要手动转)
  const data = rows.map(r => ({
    id: r.id, ownerId: r.owner_id, name: r.name, avatar: r.avatar,
    inviteToken: r.invite_token, inviteExpiresAt: r.invite_expires_at,
    autoJoin: !!r.auto_join, createdAt: r.created_at,
    myRole: r.my_role, memberCount: r.member_count,
  }));
  return c.json({ data });
});

app.post('/', async (c) => {
  const userId = c.get('userId');
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const now = dayjs().toISOString();
  const groupId = nanoid(12);
  const inviteToken = nanoid(INVITE_TOKEN_LEN);
  const inviteExpiresAt = dayjs().add(INVITE_DEFAULT_TTL_DAYS, 'day').toISOString();
  // 事务: 建群 + owner 入成员一起写, 防只建一半留脏数据. better-sqlite3 同步 driver, drizzle tx 同步
  db.transaction((tx) => {
    tx.insert(schema.groups).values({
      id: groupId, ownerId: userId, name: parsed.data.name, avatar: parsed.data.avatar ?? null,
      inviteToken, inviteExpiresAt, autoJoin: parsed.data.autoJoin, createdAt: now,
    }).run();
    tx.insert(schema.groupMembers).values({
      groupId, userId, role: 'owner', status: 'active', joinedAt: now,
    }).run();
  });
  const enriched = await enrichGroup(groupId, userId);
  return c.json({ data: enriched }, 201);
});

// 群详情: 含成员列表 + 我的角色. 仅 active member 可访问
app.get('/:id', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const me = await getActiveMember(groupId, userId);
  if (!me) return c.json({ error: '群组不存在或你不是成员' }, 404);
  const enriched = await enrichGroup(groupId, userId);
  // 成员列表 (含 user nickname/avatar, 排序: owner → admin → member, 同角色按加入时间)
  const members = db.all(sql`
    SELECT gm.user_id, gm.role, gm.joined_at, u.username, u.nickname, u.avatar
    FROM group_members gm
    INNER JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ${groupId} AND gm.status = 'active'
    ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, gm.joined_at ASC
  `) as Array<{ user_id: string; role: string; joined_at: string; username: string; nickname: string; avatar: string | null }>;
  return c.json({
    data: {
      ...enriched,
      members: members.map(m => ({
        userId: m.user_id, role: m.role, joinedAt: m.joined_at,
        username: m.username, nickname: m.nickname, avatar: m.avatar,
        online: isOnline(m.user_id),
      })),
    },
  });
});

// 群内可见笔记列表 (PR #2 群组共享). 必须 active member 才能拉. 排序 sharedAt DESC (最近被分享冲顶)
// 跟 GET /api/notes?scope=group:<id> 等价, 但路径更 RESTful + 自然返回作者头像/昵称给 NoteCard 用
app.get('/:id/notes', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const me = await getActiveMember(groupId, userId);
  if (!me) return c.json({ error: '群组不存在或你不是成员' }, 404);
  const { page = '1', limit = '50' } = c.req.query();
  const offset = (parseInt(page) - 1) * parseInt(limit);

  // 子查询: notes JOIN note_shares JOIN users (作者头像/昵称 给 NoteCard 用) LEFT JOIN group_note_pins (群内独立置顶)
  // 排序: 群内置顶冲顶 (pinned_at DESC), 同档按分享时间 (shared_at DESC)
  // 不取 notes.pinned (作者全局置顶) 因为群组语义独立, A 群里置顶跟作者在自己页里置顶完全无关
  const rows = db.all(sql`
    SELECT n.*, ns.shared_at as sharedAt, u.nickname as authorNickname, u.avatar as authorAvatar,
           gnp.pinned_at as groupPinnedAt
    FROM notes n
    INNER JOIN note_shares ns ON ns.note_id = n.id
    INNER JOIN users u ON u.id = n.user_id
    LEFT JOIN group_note_pins gnp ON gnp.note_id = n.id AND gnp.group_id = ${groupId}
    WHERE ns.group_id = ${groupId} AND n.deleted_at IS NULL
    ORDER BY (gnp.pinned_at IS NOT NULL) DESC, gnp.pinned_at DESC, ns.shared_at DESC
    LIMIT ${parseInt(limit)} OFFSET ${offset}
  `) as Array<any>;
  const totalRow = db.get(sql`
    SELECT count(*) as count FROM note_shares ns
    INNER JOIN notes n ON n.id = ns.note_id
    WHERE ns.group_id = ${groupId} AND n.deleted_at IS NULL
  `) as { count: number } | undefined;

  // PR #5b: 批量拉每条笔记的 sharedGroupIds + editPermission, 给 NoteCard 显示"已分享"chip + 群组列表里切换编辑权限
  const noteIds = rows.map(r => r.id as string);
  const sharesMap = new Map<string, string[]>();
  if (noteIds.length > 0) {
    const shareRows = db.all(sql`
      SELECT note_id, group_id FROM note_shares WHERE note_id IN (${sql.join(noteIds.map(id => sql`${id}`), sql.raw(','))})
    `) as Array<{ note_id: string; group_id: string }>;
    for (const s of shareRows) {
      const arr = sharesMap.get(s.note_id) || [];
      arr.push(s.group_id);
      sharesMap.set(s.note_id, arr);
    }
  }

  // PR #6: 拼 reaction summary + comment count (群 feed NoteCard 底部显示). 群里都是 shared 笔记, 不分支
  // PR #7b: 拼 editorCount + parentNoteId (NoteCard 显示"X 人编辑过" + "本群独占版/N 群共享版"标)
  const [{ reactionMap, commentCountMap }, editorCountMap] = await Promise.all([
    loadSocialMetaMaps(noteIds, userId),
    loadEditorCountMap(noteIds),
  ]);

  // raw SQL 返回 snake_case, 手动映射成 camelCase (跟其他 endpoint 返回格式一致)
  const data = rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    content: r.content,
    contentPinyin: r.content_pinyin,
    summary: r.summary,
    category: r.category,
    tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags,
    type: r.type,
    todoStatus: r.todo_status,
    todoDue: r.todo_due,
    todoRemindSentAt: r.todo_remind_sent_at,
    todoRemindRrule: r.todo_remind_rrule,
    aiProcessed: !!r.ai_processed,
    pinned: !!r.pinned,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    visibility: r.visibility,
    editPermission: r.edit_permission,
    parentNoteId: r.parent_note_id, // PR #7b: fork 出来的 note 指向 root id, root 自己为 null
    sharedGroupIds: sharesMap.get(r.id) || [],
    sharedAt: r.sharedAt,
    authorNickname: r.authorNickname,
    authorAvatar: r.authorAvatar,
    groupPinned: !!r.groupPinnedAt, // 群内独立置顶状态 (跟 pinned 作者全局置顶分离)
    reactionSummary: reactionMap.get(r.id) || [],
    commentCount: commentCountMap.get(r.id) || 0,
    editorCount: editorCountMap.get(r.id) || 0, // PR #7b: 非作者编辑次数, NoteCard "X 人编辑过" 显示
  }));
  return c.json({
    data,
    pagination: { page: parseInt(page), limit: parseInt(limit), total: totalRow?.count ?? 0 },
  });
});

// 群内独立置顶: owner/admin 才能操作, 必须是该群已分享的笔记
async function assertCanGroupPin(groupId: string, noteId: string, userId: string) {
  const me = await getActiveMember(groupId, userId);
  if (!me) return { error: '群组不存在或你不是成员', code: 404 } as const;
  if (me.role !== 'owner' && me.role !== 'admin') return { error: '只有管理员可以置顶群内笔记', code: 403 } as const;
  const shared = await db.select().from(schema.noteShares)
    .where(and(eq(schema.noteShares.groupId, groupId), eq(schema.noteShares.noteId, noteId))).get();
  if (!shared) return { error: '该笔记未分享到本群', code: 404 } as const;
  return null;
}

app.post('/:id/notes/:noteId/pin', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const noteId = c.req.param('noteId');
  const err = await assertCanGroupPin(groupId, noteId, userId);
  if (err) return c.json({ error: err.error }, err.code);
  // INSERT OR REPLACE: 重复 pin 时刷新 pinned_at + pinned_by (重新冲顶), 幂等
  db.run(sql`
    INSERT OR REPLACE INTO group_note_pins (group_id, note_id, pinned_by, pinned_at)
    VALUES (${groupId}, ${noteId}, ${userId}, ${dayjs().toISOString()})
  `);
  // 广播给该群其他成员让群 feed 重排
  const members = await db.select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.status, 'active')))
    .all();
  for (const m of members) {
    if (m.userId !== userId) publish(m.userId, 'group-notes-changed', { groupId });
  }
  return c.json({ message: '已置顶' });
});

app.delete('/:id/notes/:noteId/pin', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const noteId = c.req.param('noteId');
  const err = await assertCanGroupPin(groupId, noteId, userId);
  if (err) return c.json({ error: err.error }, err.code);
  await db.delete(schema.groupNotePins)
    .where(and(eq(schema.groupNotePins.groupId, groupId), eq(schema.groupNotePins.noteId, noteId)));
  const members = await db.select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.status, 'active')))
    .all();
  for (const m of members) {
    if (m.userId !== userId) publish(m.userId, 'group-notes-changed', { groupId });
  }
  return c.json({ message: '已取消置顶' });
});

// PR #5b 群级汇总: 该群所有 shared 笔记的 pending 编辑权申请 (作者+admin 看)
// 给群组详情页"编辑申请管理"面板用. 不分页, 假设每群 pending 量不大.
app.get('/:id/note-edit-requests', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const me = await getActiveMember(groupId, userId);
  if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
    return c.json({ error: '只有群管理员可以查看编辑申请' }, 403);
  }
  const rows = db.all(sql`
    SELECT r.id, r.note_id as noteId, r.user_id as userId, r.status, r.message, r.created_at as createdAt,
           u.nickname as requesterNickname, u.avatar as requesterAvatar,
           SUBSTR(n.content, 1, 80) as notePreview, n.user_id as noteAuthorId,
           au.nickname as authorNickname
    FROM note_edit_requests r
    INNER JOIN note_shares ns ON ns.note_id = r.note_id
    INNER JOIN notes n ON n.id = r.note_id
    LEFT JOIN users u ON u.id = r.user_id
    LEFT JOIN users au ON au.id = n.user_id
    WHERE ns.group_id = ${groupId} AND r.status = 'pending' AND n.deleted_at IS NULL
    ORDER BY r.created_at DESC
  `) as Array<any>;
  return c.json({ data: rows });
});

// PR #5b 群级汇总: 该群所有 shared 笔记的已授权用户 (作者+admin 看, 可撤销)
app.get('/:id/note-edit-grants', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const me = await getActiveMember(groupId, userId);
  if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
    return c.json({ error: '只有群管理员可以查看授权列表' }, 403);
  }
  const rows = db.all(sql`
    SELECT g.note_id as noteId, g.user_id as userId, g.granted_at as grantedAt, g.granted_by as grantedBy,
           u.nickname, u.avatar,
           SUBSTR(n.content, 1, 80) as notePreview, n.user_id as noteAuthorId,
           au.nickname as authorNickname
    FROM note_edit_grants g
    INNER JOIN note_shares ns ON ns.note_id = g.note_id
    INNER JOIN notes n ON n.id = g.note_id
    LEFT JOIN users u ON u.id = g.user_id
    LEFT JOIN users au ON au.id = n.user_id
    WHERE ns.group_id = ${groupId} AND n.deleted_at IS NULL
    ORDER BY g.granted_at DESC
  `) as Array<any>;
  return c.json({ data: rows });
});

app.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const me = await getActiveMember(groupId, userId);
  if (!me) return c.json({ error: '群组不存在或你不是成员' }, 403);
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  // 权限分级: name/avatar/autoJoin 仅 owner, announcement 允许 owner+admin
  const ownerOnly = parsed.data.name !== undefined
    || parsed.data.avatar !== undefined
    || parsed.data.autoJoin !== undefined;
  if (ownerOnly && me.role !== 'owner') return c.json({ error: '仅创建者可修改群设置' }, 403);
  if (parsed.data.announcement !== undefined && me.role !== 'owner' && me.role !== 'admin') {
    return c.json({ error: '仅管理员可修改群公告' }, 403);
  }
  const updates: Record<string, any> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.avatar !== undefined) updates.avatar = parsed.data.avatar;
  if (parsed.data.autoJoin !== undefined) updates.autoJoin = parsed.data.autoJoin;
  if (parsed.data.announcement !== undefined) {
    // 空串/纯空白 trim 后视为清空公告; 否则写入并记 updater
    const ann = parsed.data.announcement?.trim() || null;
    updates.announcement = ann;
    updates.announcementUpdatedAt = ann ? dayjs().toISOString() : null;
    updates.announcementUpdatedBy = ann ? userId : null;
  }
  if (Object.keys(updates).length === 0) return c.json({ error: '无变更字段' }, 400);
  await db.update(schema.groups).set(updates).where(eq(schema.groups.id, groupId));
  // 广播给所有成员 (排除操作者) 让群名/头像/autoJoin/公告 实时更新
  await broadcastGroupChanged(groupId, [userId]);
  const enriched = await enrichGroup(groupId, userId);
  return c.json({ data: enriched });
});

// 解散群: 仅 owner. 同时清 group_members + group_join_requests (后续 PR 加 note_shares 也要清)
app.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const me = await getActiveMember(groupId, userId);
  if (!me || me.role !== 'owner') return c.json({ error: '仅创建者可解散群组' }, 403);
  // 先拉所有成员 id, 解散后 SSE 通知他们 (前端从 sidebar 移除该群)
  const memberIds = (await db.select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(eq(schema.groupMembers.groupId, groupId))
    .all()).map(r => r.userId);
  db.transaction((tx) => {
    // PR #2: 群被解散后 note_shares 引用的 group_id 失效, FK constraint 会阻止 DELETE groups,
    // 先清 note_shares (笔记本体保留, 作者仍能看自己的, 群可见性彻底消失)
    tx.delete(schema.noteShares).where(eq(schema.noteShares.groupId, groupId)).run();
    tx.delete(schema.groupNotePins).where(eq(schema.groupNotePins.groupId, groupId)).run();
    tx.delete(schema.groupJoinRequests).where(eq(schema.groupJoinRequests.groupId, groupId)).run();
    tx.delete(schema.groupMembers).where(eq(schema.groupMembers.groupId, groupId)).run();
    tx.delete(schema.groups).where(eq(schema.groups.id, groupId)).run();
  });
  for (const uid of memberIds) {
    publish(uid, 'group-dissolved', { groupId });
  }
  return c.json({ message: '群组已解散' });
});

// 重置邀请 token: owner/admin. 旧 token 立即失效, 返回新 token + 过期时间
app.post('/:id/invite/reset', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const me = await getActiveMember(groupId, userId);
  if (!me || (me.role !== 'owner' && me.role !== 'admin')) return c.json({ error: '无权重置邀请' }, 403);
  const newToken = nanoid(INVITE_TOKEN_LEN);
  const newExpires = dayjs().add(INVITE_DEFAULT_TTL_DAYS, 'day').toISOString();
  await db.update(schema.groups)
    .set({ inviteToken: newToken, inviteExpiresAt: newExpires })
    .where(eq(schema.groups.id, groupId));
  // 广播给其他 active 成员 (排除操作者), 让其他 admin/owner 面板自动同步新 token
  await broadcastGroupChanged(groupId, [userId]);
  return c.json({ data: { inviteToken: newToken, inviteExpiresAt: newExpires } });
});

// 关闭邀请: owner/admin. token 设 null, 谁也加不进来 (除非 owner/admin 重新 reset)
app.delete('/:id/invite', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const me = await getActiveMember(groupId, userId);
  if (!me || (me.role !== 'owner' && me.role !== 'admin')) return c.json({ error: '无权关闭邀请' }, 403);
  await db.update(schema.groups)
    .set({ inviteToken: null, inviteExpiresAt: null })
    .where(eq(schema.groups.id, groupId));
  // 广播给其他 active 成员 (排除操作者), 让其他 admin/owner 立即看到邀请已关闭
  await broadcastGroupChanged(groupId, [userId]);
  return c.json({ message: '邀请已关闭' });
});

// =========================================================
//  申请审批 (owner / admin)
// =========================================================

// 看待审申请列表: 仅 owner/admin
app.get('/:id/join-requests', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const me = await getActiveMember(groupId, userId);
  if (!me || (me.role !== 'owner' && me.role !== 'admin')) return c.json({ error: '无权限' }, 403);
  const rows = db.all(sql`
    SELECT r.id, r.user_id, r.status, r.created_at, r.handled_at, r.handled_by,
      u.username, u.nickname, u.avatar
    FROM group_join_requests r
    INNER JOIN users u ON u.id = r.user_id
    WHERE r.group_id = ${groupId} AND r.status = 'pending'
    ORDER BY r.created_at ASC
  `) as Array<{ id: string; user_id: string; status: string; created_at: string; handled_at: string | null; handled_by: string | null; username: string; nickname: string; avatar: string | null }>;
  return c.json({
    data: rows.map(r => ({
      id: r.id, userId: r.user_id, status: r.status, createdAt: r.created_at,
      handledAt: r.handled_at, handledBy: r.handled_by,
      applicant: { username: r.username, nickname: r.nickname, avatar: r.avatar },
    })),
  });
});

// 同意申请: owner/admin. 把申请 status=approved + 创建 group_members + SSE 通知申请人
app.post('/:id/join-requests/:reqId/approve', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const reqId = c.req.param('reqId');
  const me = await getActiveMember(groupId, userId);
  if (!me || (me.role !== 'owner' && me.role !== 'admin')) return c.json({ error: '无权限' }, 403);
  const reqRow = await db.select().from(schema.groupJoinRequests)
    .where(and(eq(schema.groupJoinRequests.id, reqId), eq(schema.groupJoinRequests.groupId, groupId))).get();
  if (!reqRow) return c.json({ error: '申请不存在' }, 404);
  if (reqRow.status !== 'pending') return c.json({ error: '申请已被处理' }, 400);
  const now = dayjs().toISOString();
  // 已经是 active member 的极少数 race case: 跳过 insert 防主键冲突, 仅更新申请状态
  const existing = await db.select().from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, reqRow.userId))).get();
  db.transaction((tx) => {
    if (existing) {
      // 之前被踢的人重新申请 (status=removed → active), 或者已经是 active (重复审批 race)
      tx.update(schema.groupMembers)
        .set({ status: 'active', joinedAt: now })
        .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, reqRow.userId)))
        .run();
    } else {
      tx.insert(schema.groupMembers).values({
        groupId, userId: reqRow.userId, role: 'member', status: 'active', joinedAt: now,
      }).run();
    }
    tx.update(schema.groupJoinRequests)
      .set({ status: 'approved', handledAt: now, handledBy: userId })
      .where(eq(schema.groupJoinRequests.id, reqId))
      .run();
  });
  publish(reqRow.userId, 'group-join-approved', { groupId, requestId: reqId });
  // 广播给其他成员 (排除操作者 + 申请人, 申请人通过 group-join-approved 触发 loadGroups)
  await broadcastGroupChanged(groupId, [userId, reqRow.userId]);
  return c.json({ message: '已同意' });
});

app.post('/:id/join-requests/:reqId/reject', async (c) => {
  const userId = c.get('userId');
  const groupId = c.req.param('id');
  const reqId = c.req.param('reqId');
  const me = await getActiveMember(groupId, userId);
  if (!me || (me.role !== 'owner' && me.role !== 'admin')) return c.json({ error: '无权限' }, 403);
  const reqRow = await db.select().from(schema.groupJoinRequests)
    .where(and(eq(schema.groupJoinRequests.id, reqId), eq(schema.groupJoinRequests.groupId, groupId))).get();
  if (!reqRow) return c.json({ error: '申请不存在' }, 404);
  if (reqRow.status !== 'pending') return c.json({ error: '申请已被处理' }, 400);
  const now = dayjs().toISOString();
  await db.update(schema.groupJoinRequests)
    .set({ status: 'rejected', handledAt: now, handledBy: userId })
    .where(eq(schema.groupJoinRequests.id, reqId));
  publish(reqRow.userId, 'group-join-rejected', { groupId, requestId: reqId });
  return c.json({ message: '已拒绝' });
});

// =========================================================
//  成员管理
// =========================================================

// 踢人 (owner/admin) 或 自己退群 (任何 member). owner 不能踢自己 (用解散群代替)
app.delete('/:id/members/:userId', async (c) => {
  const meId = c.get('userId');
  const groupId = c.req.param('id');
  const targetId = c.req.param('userId');
  const me = await getActiveMember(groupId, meId);
  if (!me) return c.json({ error: '群组不存在或你不是成员' }, 404);
  const isSelf = meId === targetId;
  if (isSelf && me.role === 'owner') {
    return c.json({ error: '创建者请用"解散群组"而非退群' }, 400);
  }
  // 踢别人: 要 owner/admin
  if (!isSelf && me.role !== 'owner' && me.role !== 'admin') {
    return c.json({ error: '无权限踢人' }, 403);
  }
  // admin 不能踢 owner, 也不能踢其他 admin (避免互踢)
  if (!isSelf && me.role === 'admin') {
    const target = await getActiveMember(groupId, targetId);
    if (target && (target.role === 'owner' || target.role === 'admin')) {
      return c.json({ error: '管理员不能踢创建者或其他管理员' }, 403);
    }
  }
  const now = dayjs().toISOString();
  await db.update(schema.groupMembers)
    .set({ status: 'removed' })
    .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, targetId)));
  // 主动退群不需要推 SSE 给自己 (前端已知道 + 已 toast), 只在被别人踢时推
  if (!isSelf) publish(targetId, 'group-member-removed', { groupId, by: meId, self: false });
  // 广播给剩余成员 (status='removed' 的人不在 active 列表自动排除, 不会通知到自己)
  await broadcastGroupChanged(groupId, [meId]);
  return c.json({ message: isSelf ? '已退群' : '已移除' });
});

const roleSchema = z.object({ role: z.enum(['admin', 'member']) });

// 改成员角色 (owner only, admin/member 互转, 不能转 owner)
app.patch('/:id/members/:userId', async (c) => {
  const meId = c.get('userId');
  const groupId = c.req.param('id');
  const targetId = c.req.param('userId');
  const me = await getActiveMember(groupId, meId);
  if (!me || me.role !== 'owner') return c.json({ error: '仅创建者可改角色' }, 403);
  if (meId === targetId) return c.json({ error: '不能修改自己角色' }, 400);
  const parsed = roleSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const target = await getActiveMember(groupId, targetId);
  if (!target) return c.json({ error: '该成员不存在或已被移除' }, 404);
  if (target.role === 'owner') return c.json({ error: '不能改创建者角色' }, 400);
  await db.update(schema.groupMembers)
    .set({ role: parsed.data.role })
    .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, targetId)));
  // 广播给所有成员让 chip 颜色实时更新 (排除操作者)
  await broadcastGroupChanged(groupId, [meId]);
  return c.json({ message: '已更新' });
});

export default app;
export { inviteApp };
