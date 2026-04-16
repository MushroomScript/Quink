import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { authMiddleware } from '../auth.js';

const app = new Hono();

app.use('*', authMiddleware);

const createCategorySchema = z.object({
  name: z.string().min(1),
  parentId: z.number().nullable().optional(),
  icon: z.string().optional(),
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
  const body = await c.req.json();
  const parsed = createCategorySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const result = await db.insert(schema.categories).values({
    name: parsed.data.name,
    userId,
    parentId: parsed.data.parentId ?? null,
    icon: parsed.data.icon ?? null,
    sortOrder: parsed.data.sortOrder,
  }).returning();

  return c.json({ data: result[0] }, 201);
});

app.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const id = parseInt(c.req.param('id'));
  const { name } = await c.req.json();
  if (!name?.trim()) return c.json({ error: '名称不能为空' }, 400);
  const cat = await db.select().from(schema.categories).where(and(eq(schema.categories.id, id), eq(schema.categories.userId, userId))).get();
  if (!cat) return c.json({ error: '分类不存在' }, 404);
  await db.update(schema.categories).set({ name: name.trim() }).where(eq(schema.categories.id, id));
  return c.json({ data: { ...cat, name: name.trim() } });
});

app.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = parseInt(c.req.param('id'));
  const cat = await db.select().from(schema.categories).where(and(eq(schema.categories.id, id), eq(schema.categories.userId, userId))).get();
  if (!cat) return c.json({ error: '分类不存在' }, 404);
  await db.delete(schema.categories).where(eq(schema.categories.id, id));
  return c.json({ message: '已删除' });
});

export default app;
