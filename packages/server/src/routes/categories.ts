import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { authMiddleware } from '../auth.js';
import { publish } from '../reminder/bus.js';
import { logAudit } from '../utils/auditLog.js';

const app = new Hono();

app.use('*', authMiddleware);

const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  parentId: z.number().nullable().optional(),
  icon: z.string().max(64).optional(),
  sortOrder: z.number().default(0),
});

app.get('/', async (c) => {
  const userId = c.get('userId');
  const all = await db.select().from(schema.categories).where(eq(schema.categories.userId, userId)).all();

  const map = new Map<number, any>();
  const roots: any[] = [];
  for (const cat of all) map.set(cat.id, { ...cat, children: [] });
  for (const cat of all) {
    const node = map.get(cat.id)!;
    if (cat.parentId && map.has(cat.parentId)) map.get(cat.parentId)!.children.push(node);
    else roots.push(node);
  }
  return c.json({ data: roots });
});

app.post('/', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const body = await c.req.json();
  const parsed = createCategorySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // 安全审计 L6: 校验 parentId 必须是同用户的分类 (防跨用户挂载 / 防注入不存在 ID)
  if (parsed.data.parentId !== null && parsed.data.parentId !== undefined) {
    const parent = await db.select({ id: schema.categories.id }).from(schema.categories)
      .where(and(eq(schema.categories.id, parsed.data.parentId), eq(schema.categories.userId, userId))).get();
    if (!parent) return c.json({ error: 'parentId 不存在或非本人分类' }, 400);
  }

  const result = await db.insert(schema.categories).values({
    name: parsed.data.name,
    userId,
    parentId: parsed.data.parentId ?? null,
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
