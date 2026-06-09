import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, and, asc, inArray, sql } from 'drizzle-orm';
import { authMiddleware } from '../auth.js';
import { publish } from '../reminder/bus.js';
import { logAudit } from '../utils/auditLog.js';

const app = new Hono();

app.use('*', authMiddleware);

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  icon: z.string().max(64).optional(),
  sortOrder: z.number().default(0),
});

app.get('/', async (c) => {
  const userId = c.get('userId');
  // 蘑菇 2026-06-09: 系统只支持一级分类, schema 已删 parentId. 排序: sortOrder ASC + id ASC (POST /reorder 维护)
  const roots = await db.select().from(schema.categories)
    .where(eq(schema.categories.userId, userId))
    .orderBy(asc(schema.categories.sortOrder), asc(schema.categories.id))
    .all();
  return c.json({ data: roots });
});

const reorderSchema = z.object({
  orderedIds: z.array(z.number().int().positive()).max(500),
});

// 批量重排 root 分类. body 里 orderedIds 是新顺序的 id 数组, 后端按 index 写 sortOrder
// 校验所有 id 都是该用户的 (防跨用户改顺序). child 分类的 sortOrder 不动 (保持默认 0)
app.post('/reorder', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const body = await c.req.json();
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const ids = parsed.data.orderedIds;
  if (ids.length === 0) return c.json({ message: 'ok' });

  const myCats = await db.select({ id: schema.categories.id }).from(schema.categories)
    .where(and(eq(schema.categories.userId, userId), inArray(schema.categories.id, ids)))
    .all();
  if (myCats.length !== ids.length) return c.json({ error: 'orderedIds 包含非本人分类' }, 400);

  // better-sqlite3 同步事务批量 update
  db.transaction((tx) => {
    ids.forEach((id, idx) => {
      tx.update(schema.categories).set({ sortOrder: idx }).where(eq(schema.categories.id, id)).run();
    });
  });

  publish(userId, 'data-changed', { scope: 'categories' }, _ocid);
  await logAudit(c, 'category.reorder', 'category', null, { count: ids.length });
  return c.json({ message: 'ok' });
});

app.post('/', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const body = await c.req.json();
  const parsed = createCategorySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const result = await db.insert(schema.categories).values({
    name: parsed.data.name,
    userId,
    icon: parsed.data.icon ?? null,
    sortOrder: parsed.data.sortOrder,
  }).returning();
  publish(userId, 'data-changed', { scope: 'categories' }, _ocid);
  await logAudit(c, 'category.create', 'category', String(result[0].id), { name: parsed.data.name });
  return c.json({ data: result[0] }, 201);
});

app.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const id = parseInt(c.req.param('id'));
  const { name } = await c.req.json();
  if (!name?.trim()) return c.json({ error: '名称不能为空' }, 400);
  const cat = await db.select().from(schema.categories).where(and(eq(schema.categories.id, id), eq(schema.categories.userId, userId))).get();
  if (!cat) return c.json({ error: '分类不存在' }, 404);
  await db.update(schema.categories).set({ name: name.trim() }).where(eq(schema.categories.id, id));
  publish(userId, 'data-changed', { scope: 'categories' }, _ocid);
  await logAudit(c, 'category.rename', 'category', String(id), { old: cat.name, new: name.trim() });
  return c.json({ data: { ...cat, name: name.trim() } });
});

app.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const id = parseInt(c.req.param('id'));
  const cat = await db.select().from(schema.categories).where(and(eq(schema.categories.id, id), eq(schema.categories.userId, userId))).get();
  if (!cat) return c.json({ error: '分类不存在' }, 404);
  // 清空关联笔记的分类
  await db.update(schema.notes).set({ category: null })
    .where(and(eq(schema.notes.userId, userId), eq(schema.notes.category, cat.name)));
  await db.delete(schema.categories).where(eq(schema.categories.id, id));
  publish(userId, 'data-changed', { scope: 'categories' }, _ocid);
  await logAudit(c, 'category.delete', 'category', String(id), { name: cat.name });
  return c.json({ message: '已删除' });
});

export default app;
