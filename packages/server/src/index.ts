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
    .from(schema.notes).where(eq(schema.notes.userId, userId)).get();
  const totalTodos = db.select({ count: sql<number>`count(*)` })
    .from(schema.notes).where(and(eq(schema.notes.userId, userId), eq(schema.notes.type, 'todo'))).get();
  const pendingTodos = db.select({ count: sql<number>`count(*)` })
    .from(schema.notes).where(
      and(eq(schema.notes.userId, userId), sql`${schema.notes.type} = 'todo' AND ${schema.notes.todoStatus} = 'pending'`)
    ).get();

  // 每日记录数（热力图，最近365天）
  const dailyCounts = db.all(sql`
    SELECT substr(${schema.notes.createdAt}, 1, 10) as date, count(*) as count
    FROM notes WHERE user_id = ${userId} AND deleted_at IS NULL
    GROUP BY date ORDER BY date
  `) as { date: string; count: number }[];

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

// 自动清理过期回收站（默认30天）
import dayjs from 'dayjs';
function cleanTrash() {
  try {
    const cutoff = dayjs().subtract(30, 'day').toISOString();
    db.delete(schema.notes).where(sql`${schema.notes.deletedAt} IS NOT NULL AND ${schema.notes.deletedAt} < ${cutoff}`).run();
  } catch {}
}
cleanTrash();
setInterval(cleanTrash, 6 * 60 * 60 * 1000); // 每6小时清理一次
