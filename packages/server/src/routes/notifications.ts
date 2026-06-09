// PR #10 通知中心后端
// 6 endpoint: list / unread-count / read-one / read-all / delete-one / clear
// 写 endpoint 跟其他模块同款 publish('notification-changed', ...) 让发起人多设备 SSE 同步,
// 'notification-new' 则由 createNotification helper 在事件源头发送 (申请编辑权 / 评论等接入点 PR #10c 改造)

import { Hono } from 'hono';
import { db, schema } from '../db/index.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { authMiddleware } from '../auth.js';
import { publish } from '../reminder/bus.js';
import { logAudit } from '../utils/auditLog.js';
import dayjs from 'dayjs';

const app = new Hono();

app.use('*', authMiddleware);

const VALID_CATEGORIES = ['content', 'reminder', 'group'] as const;
type ValidCategory = typeof VALID_CATEGORIES[number];

function parseCategory(raw: string | undefined): ValidCategory | null {
  if (!raw) return null;
  return VALID_CATEGORIES.includes(raw as ValidCategory) ? (raw as ValidCategory) : null;
}

// GET /api/notifications?category=&page=&limit=  列通知 (按 created_at DESC)
// category 不传 = 全部 tab; page 默认 1; limit 默认 20 上限 100 (单页太大滚动卡)
app.get('/', async (c) => {
  const userId = c.get('userId');
  const rawCat = c.req.query('category');
  const category = parseCategory(rawCat);
  if (rawCat && !category) return c.json({ error: 'invalid category' }, 400);
  const page = Math.max(1, parseInt(c.req.query('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')));
  const offset = (page - 1) * limit;

  const whereClause = category
    ? and(eq(schema.notifications.userId, userId), eq(schema.notifications.category, category))
    : eq(schema.notifications.userId, userId);

  const [rows, totalRow] = await Promise.all([
    db.select().from(schema.notifications)
      .where(whereClause)
      .orderBy(desc(schema.notifications.createdAt))
      .limit(limit).offset(offset).all(),
    db.select({ count: sql<number>`count(*)` }).from(schema.notifications).where(whereClause).get(),
  ]);
  return c.json({ data: rows, total: totalRow?.count ?? 0, page, limit });
});

// GET /api/notifications/unread-count  返回 { total, content, reminder, group } 给徽章 + tab 标记用
app.get('/unread-count', async (c) => {
  const userId = c.get('userId');
  const rows = await db.select({
    category: schema.notifications.category,
    count: sql<number>`count(*)`,
  })
    .from(schema.notifications)
    .where(and(
      eq(schema.notifications.userId, userId),
      sql`${schema.notifications.readAt} IS NULL`,
    ))
    .groupBy(schema.notifications.category)
    .all();
  const byCategory: Record<string, number> = { content: 0, reminder: 0, group: 0 };
  let total = 0;
  for (const r of rows) {
    byCategory[r.category] = r.count;
    total += r.count;
  }
  return c.json({ data: { total, ...byCategory } });
});

// POST /api/notifications/:id/read  标已读. idempotent (已读再标无副作用)
app.post('/:id/read', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const id = c.req.param('id');
  const row = await db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId)))
    .get();
  if (!row) return c.json({ error: '通知不存在' }, 404);
  if (!row.readAt) {
    await db.update(schema.notifications).set({ readAt: dayjs().toISOString() })
      .where(eq(schema.notifications.id, id));
  }
  publish(userId, 'notification-changed', { scope: 'read', id }, _ocid);
  // PR #13 followup: read 是高频操作 (用户点几十次/天) 无掩盖嫌疑, 砍 audit 防 spam audit_logs 表
  return c.json({ data: { id, readAt: row.readAt ?? dayjs().toISOString() } });
});

// POST /api/notifications/read-all?category=  全部标已读. category 不传 = 全部 tab
app.post('/read-all', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const rawCat = c.req.query('category');
  const category = parseCategory(rawCat);
  if (rawCat && !category) return c.json({ error: 'invalid category' }, 400);

  const whereClause = category
    ? and(
        eq(schema.notifications.userId, userId),
        eq(schema.notifications.category, category),
        sql`${schema.notifications.readAt} IS NULL`,
      )
    : and(eq(schema.notifications.userId, userId), sql`${schema.notifications.readAt} IS NULL`);

  const now = dayjs().toISOString();
  const result = await db.update(schema.notifications).set({ readAt: now }).where(whereClause);
  publish(userId, 'notification-changed', { scope: 'read-all', category: category ?? null }, _ocid);
  // PR #13 followup: read-all 是高频 + 无掩盖嫌疑, 砍 audit 防 spam (delete/clear 仍留, 才是掩盖证据的核心场景)
  return c.json({ data: { updated: result.changes ?? 0 } });
});

// DELETE /api/notifications/:id  删一条
app.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const id = c.req.param('id');
  const row = await db.select({ id: schema.notifications.id }).from(schema.notifications)
    .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId)))
    .get();
  if (!row) return c.json({ error: '通知不存在' }, 404);
  await db.delete(schema.notifications).where(eq(schema.notifications.id, id));
  publish(userId, 'notification-changed', { scope: 'delete', id }, _ocid);
  await logAudit(c, 'notification.delete', 'notification', id);
  return c.json({ message: '已删除' });
});

// DELETE /api/notifications?category=  清空当前 tab (不传 = 全部清)
app.delete('/', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const rawCat = c.req.query('category');
  const category = parseCategory(rawCat);
  if (rawCat && !category) return c.json({ error: 'invalid category' }, 400);

  const whereClause = category
    ? and(eq(schema.notifications.userId, userId), eq(schema.notifications.category, category))
    : eq(schema.notifications.userId, userId);

  const result = await db.delete(schema.notifications).where(whereClause);
  publish(userId, 'notification-changed', { scope: 'clear', category: category ?? null }, _ocid);
  await logAudit(c, 'notification.clear', 'notification', null, { category: category ?? null, deleted: result.changes ?? 0 });
  return c.json({ data: { deleted: result.changes ?? 0 } });
});

export default app;
