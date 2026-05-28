import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { eq, and, sql } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { authMiddleware } from './auth.js';
import { serveStatic } from '@hono/node-server/serve-static';
import authRoutes from './routes/auth.js';
import notesRoutes from './routes/notes.js';
import categoriesRoutes from './routes/categories.js';
import uploadRoutes from './routes/upload.js';
import aiConfigRoutes from './routes/ai-config.js';
import aiChatRoutes from './routes/ai-chat.js';
import exportRoutes from './routes/export.js';

const app = new Hono();

// Middleware
app.use('*', cors());
app.use('*', logger());

// Static files (uploaded avatars etc.)
app.use('/api/uploads/*', serveStatic({ root: './', rewriteRequestPath: (path) => path.replace('/api/uploads', '/uploads') }));

// Routes
app.route('/api/auth', authRoutes);
app.route('/api/notes', notesRoutes);
app.route('/api/categories', categoriesRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/ai/chat', aiChatRoutes);
app.route('/api/ai', aiConfigRoutes);
app.route('/api/data', exportRoutes); // GET /api/data = export, POST /api/data = import

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
