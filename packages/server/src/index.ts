import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { eq, and, sql, inArray, like } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { authMiddleware, verifyToken } from './auth.js';
import { serveStatic } from '@hono/node-server/serve-static';
import authRoutes from './routes/auth.js';
import notesRoutes from './routes/notes.js';
import categoriesRoutes from './routes/categories.js';
import uploadRoutes from './routes/upload.js';
import aiConfigRoutes from './routes/ai-config.js';
import aiChatRoutes from './routes/ai-chat.js';
import exportRoutes from './routes/export.js';
import reminderChannelsRoutes from './routes/reminder-channels.js';
import sseRoutes from './routes/sse.js';
import groupsRoutes, { inviteApp } from './routes/groups.js';
import { startReminderScheduler } from './reminder/scheduler.js';

const app = new Hono();

// Middleware
app.use('*', cors());
app.use('*', logger());

// Static files (uploaded avatars etc.)
// PR #3 群组文件授权: query token 鉴权 + files 表查作者 + note_shares 查群可见性.
// avatar 不入 files 表 → 默认公开放行 (跨用户能看头像). file 入 files 表 → 走鉴权
app.use('/api/uploads/*', async (c, next) => {
  // 1. 拿 token (优先 query, 兼容 Authorization header / Cookie 给 fetch 客户端)
  const queryToken = c.req.query('token');
  const headerAuth = c.req.header('Authorization');
  const headerToken = headerAuth?.startsWith('Bearer ') ? headerAuth.slice(7) : null;
  const token = queryToken || headerToken;
  if (!token) return c.json({ error: '未登录' }, 401);
  const payload = verifyToken(token);
  if (!payload) return c.json({ error: '登录已过期' }, 401);
  const userId = payload.sub;

  // 2. 拿 url path 最后一段 (含 .thumb.jpg 后缀的也对应原 url 鉴权)
  const path = new URL(c.req.url).pathname;
  let filename = path.replace(/^\/api\/uploads\//, '');
  // .thumb.jpg 缩略图对应原文件鉴权 (作者裸名 xxx.png, thumb 路径 xxx.png.thumb.jpg)
  const isThumb = filename.endsWith('.thumb.jpg');
  if (isThumb) filename = filename.slice(0, -('.thumb.jpg'.length));

  // 3. 查 files 表 (avatar 不入表所以查不到 → 公开放行)
  const file = await db.select().from(schema.files).where(eq(schema.files.url, filename)).get();
  if (!file) {
    // 头像 / 历史孤儿: 公开. 让 serveStatic 处理或返回 404
    return next();
  }

  // 4. 作者本人 → 放行
  if (file.userId === userId) return next();

  // 5. 查 url 是否出现在某 shared 笔记 content + 我是该群 active member → 放行
  // LIKE %filename% 简化匹配 (笔记 content markdown 内嵌的 url 是裸名, 直接 LIKE 命中)
  const linked = await db.select({ id: schema.notes.id })
    .from(schema.notes)
    .where(and(
      sql`${schema.notes.deletedAt} IS NULL`,
      eq(schema.notes.visibility, 'shared'),
      like(schema.notes.content, `%${filename}%`),
    )).all();
  if (linked.length === 0) return c.json({ error: '无权访问此文件' }, 403);

  // 该文件出现在 N 个共享笔记里, 任一笔记在我所在群 → 放行
  const linkedIds = linked.map(n => n.id);
  const shared = await db.select({ noteId: schema.noteShares.noteId, groupId: schema.noteShares.groupId })
    .from(schema.noteShares)
    .where(inArray(schema.noteShares.noteId, linkedIds))
    .all();
  if (shared.length === 0) return c.json({ error: '无权访问此文件' }, 403);

  const myGroups = await db.select({ groupId: schema.groupMembers.groupId })
    .from(schema.groupMembers)
    .where(and(
      eq(schema.groupMembers.userId, userId),
      eq(schema.groupMembers.status, 'active'),
      inArray(schema.groupMembers.groupId, [...new Set(shared.map(s => s.groupId))]),
    )).all();
  if (myGroups.length === 0) return c.json({ error: '无权访问此文件' }, 403);

  return next();
});
app.use('/api/uploads/*', serveStatic({ root: './', rewriteRequestPath: (path) => path.replace('/api/uploads', '/uploads') }));

// Routes
app.route('/api/auth', authRoutes);
app.route('/api/notes', notesRoutes);
app.route('/api/categories', categoriesRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/ai/chat', aiChatRoutes);
app.route('/api/ai', aiConfigRoutes);
app.route('/api/data', exportRoutes); // GET /api/data = export, POST /api/data = import
app.route('/api/reminder-channels', reminderChannelsRoutes);
app.route('/api/sse', sseRoutes);
app.route('/api/groups', groupsRoutes);
// 邀请页 + 申请走独立挂载点 (GET /api/invite/:token 公开不需 auth, POST .../apply 内部加 authMiddleware)
app.route('/api/invite', inviteApp);

// Health check（不需要登录）
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', name: 'Quink Server', version: '0.1.0' });
});

// Stats（需要登录）
app.get('/api/stats', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const totalNotes = db.select({ count: sql<number>`count(*)` })
    .from(schema.notes).where(and(eq(schema.notes.userId, userId), sql`${schema.notes.deletedAt} IS NULL`)).get();
  const totalTodos = db.select({ count: sql<number>`count(*)` })
    .from(schema.notes).where(and(eq(schema.notes.userId, userId), eq(schema.notes.type, 'todo'), sql`${schema.notes.deletedAt} IS NULL`)).get();
  const pendingTodos = db.select({ count: sql<number>`count(*)` })
    .from(schema.notes).where(
      and(eq(schema.notes.userId, userId), sql`${schema.notes.type} = 'todo' AND ${schema.notes.todoStatus} = 'pending' AND ${schema.notes.deletedAt} IS NULL`)
    ).get();

  // 每日记录数（热力图）+ 按 type 分组(tooltip 显示当天灵感/笔记/待办/链接各几条)
  const dailyCounts = db.all(sql`
    SELECT substr(${schema.notes.createdAt}, 1, 10) as date,
      count(*) as count,
      sum(case when ${schema.notes.type} = 'note' then 1 else 0 end) as noteCount,
      sum(case when ${schema.notes.type} = 'snippet' then 1 else 0 end) as snippetCount,
      sum(case when ${schema.notes.type} = 'todo' then 1 else 0 end) as todoCount,
      sum(case when ${schema.notes.type} = 'link' then 1 else 0 end) as linkCount
    FROM notes WHERE user_id = ${userId} AND deleted_at IS NULL
    GROUP BY date ORDER BY date
  `) as { date: string; count: number; noteCount: number; snippetCount: number; todoCount: number; linkCount: number }[];

  // 分类分布（饼图）
  const categoryDist = db.all(sql`
    SELECT COALESCE(${schema.notes.category}, '未分类') as category, count(*) as count
    FROM notes WHERE user_id = ${userId} AND deleted_at IS NULL
    GROUP BY category ORDER BY count DESC
  `) as { category: string; count: number }[];

  // 类型分布
  const typeDist = db.all(sql`
    SELECT ${schema.notes.type} as type, count(*) as count
    FROM notes WHERE user_id = ${userId} AND deleted_at IS NULL
    GROUP BY type
  `) as { type: string; count: number }[];

  return c.json({
    data: {
      totalNotes: totalNotes?.count ?? 0,
      totalTodos: totalTodos?.count ?? 0,
      pendingTodos: pendingTodos?.count ?? 0,
      dailyCounts,
      categoryDist,
      typeDist,
    },
  });
});

const PORT = parseInt(process.env.QUINK_PORT || '38999');

console.log(`
  ╭──────────────────────────────────────╮
  │                                      │
  │   Quink Server v0.1.0                │
  │   http://localhost:${PORT}              │
  │                                      │
  ╰──────────────────────────────────────╯
`);

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' });

// 异步给升级前已上传但还没 thumb 的 HEIC 文件批量补 .thumb.jpg. 不阻塞启动
(async () => {
  const [{ backfillHeicThumbs }, { resolve: resolvePath }] = await Promise.all([
    import('./utils/heicThumb.js'),
    import('path'),
  ]);
  const dir = resolvePath(process.cwd(), 'uploads');
  backfillHeicThumbs(dir).catch((e) => console.warn('[backfillHeicThumbs]', e?.message));
})();

// 启动 + 每 6h 跑一次全量清理 (用户改 trashRetentionDays 时另在 PATCH /me 处单独触发该用户的清理, 见 cleanup.ts)
import { cleanAllTrash } from './cleanup.js';
cleanAllTrash();
setInterval(cleanAllTrash, 6 * 60 * 60 * 1000);

// 待办提醒 scheduler: 每分钟扫表, 命中 todoDue <= now 的待办 -> 发到所有 enabled channels
startReminderScheduler();
