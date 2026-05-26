import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, desc, like, or, and, sql, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import { authMiddleware } from '../auth.js';
import { autoTag, autoClassify, autoSummary } from '../ai/client.js';
import { toPinyinSearchable } from '../utils/pinyin.js';

const app = new Hono();

// 所有笔记路由都需要登录
app.use('*', authMiddleware);

const createNoteSchema = z.object({
  content: z.string().min(1),
  type: z.enum(['note', 'todo', 'snippet', 'link']).default('note'),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  todoDue: z.string().optional(),
});

const updateNoteSchema = z.object({
  content: z.string().min(1).optional(),
  summary: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  type: z.enum(['note', 'todo', 'snippet', 'link']).optional(),
  todoStatus: z.enum(['pending', 'done']).optional(),
  todoDue: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
});

// GET /api/notes
app.get('/', async (c) => {
  const userId = c.get('userId');
  const { search, category, type, tag, tags, types, dateFrom, dateTo, page = '1', limit = '50' } = c.req.query();
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const conditions: any[] = [
    eq(schema.notes.userId, userId),
    sql`${schema.notes.deletedAt} IS NULL`, // 排除回收站
  ];

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
    .orderBy(desc(schema.notes.pinned), desc(schema.notes.createdAt))
    .limit(parseInt(limit))
    .offset(offset);

  // 总数也带条件
  const countResult = db.select({ count: sql<number>`count(*)` })
    .from(schema.notes)
    .where(and(...conditions))
    .get();

  return c.json({
    data: results,
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
  return c.json({ data: results });
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
  await db.delete(schema.notes).where(and(eq(schema.notes.id, id), eq(schema.notes.userId, userId)));
  return c.json({ message: '已永久删除' });
});

// DELETE /api/notes/trash — 清空
app.delete('/trash', async (c) => {
  const userId = c.get('userId');
  await db.delete(schema.notes).where(and(eq(schema.notes.userId, userId), sql`${schema.notes.deletedAt} IS NOT NULL`));
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

// GET /api/notes/:id
app.get('/:id', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  const note = await db.select().from(schema.notes)
    .where(and(eq(schema.notes.id, id), eq(schema.notes.userId, userId)))
    .get();

  if (!note) return c.json({ error: '笔记不存在' }, 404);
  return c.json({ data: note });
});

// POST /api/notes
app.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const parsed = createNoteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

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
    summary: null,
    aiProcessed: false,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(schema.notes).values(note);

  // 异步 AI 处理（不阻塞响应）
  processNoteWithAi(userId, note.id, note.content, note.tags as string[]).catch(() => {});

  return c.json({ data: note }, 201);
});

// PATCH /api/notes/:id
app.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  const body = await c.req.json();
  const parsed = updateNoteSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const existing = await db.select().from(schema.notes)
    .where(and(eq(schema.notes.id, id), eq(schema.notes.userId, userId)))
    .get();
  if (!existing) return c.json({ error: '笔记不存在' }, 404);

  const updates: Record<string, any> = { updatedAt: dayjs().toISOString() };
  const data = parsed.data;
  if (data.content !== undefined) {
    updates.content = data.content;
    updates.contentPinyin = toPinyinSearchable(data.content);
  }
  if (data.summary !== undefined) updates.summary = data.summary;
  if (data.category !== undefined) updates.category = data.category;
  if (data.tags !== undefined) updates.tags = data.tags;
  if (data.type !== undefined) updates.type = data.type;
  if (data.todoStatus !== undefined) updates.todoStatus = data.todoStatus;
  if (data.todoDue !== undefined) updates.todoDue = data.todoDue;
  if (data.pinned !== undefined) updates.pinned = data.pinned;

  await db.update(schema.notes).set(updates).where(eq(schema.notes.id, id));
  const updated = await db.select().from(schema.notes).where(eq(schema.notes.id, id)).get();
  return c.json({ data: updated });
});

// DELETE /api/notes/:id — 软删除（移入回收站）
app.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();

  const existing = await db.select().from(schema.notes)
    .where(and(eq(schema.notes.id, id), eq(schema.notes.userId, userId)))
    .get();
  if (!existing) return c.json({ error: '笔记不存在' }, 404);

  await db.update(schema.notes)
    .set({ deletedAt: dayjs().toISOString() })
    .where(eq(schema.notes.id, id));
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
      autoClassify(userId, content),
      summaryEnabled && plainTextLen >= summaryMinLen ? autoSummary(userId, content) : Promise.resolve(null),
    ]);

    const updates: Record<string, any> = { aiProcessed: true };
    if (tags.length > 0 && existingTags.length === 0) updates.tags = tags;
    if (category) {
      updates.category = category;
      // 自动创建分类（如果不存在）
      const existing = await db.select().from(schema.categories)
        .where(and(eq(schema.categories.userId, userId), eq(schema.categories.name, category))).get();
      if (!existing) {
        await db.insert(schema.categories).values({
          userId, name: category, parentId: null, icon: null, sortOrder: 0,
        }).catch(() => {}); // 忽略重复
      }
    }
    if (summary) updates.summary = summary;

    await db.update(schema.notes).set(updates).where(eq(schema.notes.id, noteId));
    console.log(`[AI] Note ${noteId}: tags=${JSON.stringify(tags)}, category=${category}, summary=${summary}`);
  } catch (err) {
    console.error(`[AI] Failed to process note ${noteId}:`, err);
  }
}

export default app;
