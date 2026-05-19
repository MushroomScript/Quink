import { db, schema } from '../db/index.js';
import { eq, and, or, like, desc, sql, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';

// ── OpenAI Function Calling 格式工具定义 ──

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_notes',
      description: '搜索用户的笔记。可按关键词、类型、分类、标签、日期范围筛选。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（匹配内容、摘要、标签）' },
          type: { type: 'string', enum: ['note', 'todo', 'snippet', 'link'], description: '笔记类型筛选' },
          category: { type: 'string', description: '分类名称筛选' },
          tags: { type: 'string', description: '标签筛选，逗号分隔，AND 匹配' },
          dateFrom: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          dateTo: { type: 'string', description: '截止日期 YYYY-MM-DD' },
          limit: { type: 'number', description: '返回数量，默认10' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_note',
      description: '根据笔记ID获取单条笔记的完整内容。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '笔记ID' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_todos',
      description: '获取用户的待办事项列表。可按完成状态筛选。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'done', 'all'], description: '待办状态，默认all' },
          limit: { type: 'number', description: '返回数量，默认20' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_recent_notes',
      description: '获取用户最近创建的笔记。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['note', 'todo', 'snippet', 'link'], description: '按类型筛选' },
          limit: { type: 'number', description: '返回数量，默认10' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_categories',
      description: '获取用户的所有笔记分类列表。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_tags',
      description: '获取用户的所有标签列表。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_stats',
      description: '获取用户的笔记统计数据：总笔记数、待办数、未完成待办数、分类分布等。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_voice_transcription',
      description: '获取语音备忘的文字转写内容。',
      parameters: {
        type: 'object',
        properties: {
          audioUrl: { type: 'string', description: '语音文件URL' },
        },
        required: ['audioUrl'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_note',
      description: '为用户创建一条新笔记或待办。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '笔记内容（Markdown格式）' },
          type: { type: 'string', enum: ['note', 'todo', 'snippet'], description: '类型，默认note' },
          category: { type: 'string', description: '分类' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签数组' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_note',
      description: '更新一条笔记的内容、分类、标签、待办状态或置顶状态。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '笔记ID' },
          content: { type: 'string', description: '新内容' },
          category: { type: 'string', description: '新分类' },
          tags: { type: 'array', items: { type: 'string' }, description: '新标签' },
          todoStatus: { type: 'string', enum: ['pending', 'done'], description: '待办状态' },
          pinned: { type: 'boolean', description: '是否置顶' },
        },
        required: ['id'],
      },
    },
  },
];

// ── 工具执行 ──

function cleanContent(content: string): string {
  return content
    // 引用链接：保留 label 文本 + 笔记 ID，让 AI 能直接 get_note(id) 拿详情
    .replace(/\[([\s\S]*?)\]\(\/?[?&]ref=([^)]+)\)/g, (_, label, rawRefId) => {
      const clean = (label as string).replace(/^📌\s*/, '').trim();
      const refId = rawRefId.split('&')[0]; // 去掉额外 query params
      return clean ? `「${clean}」(refId:${refId})` : `(refId:${refId})`;
    })
    .replace(/\[语音备忘\s*\d+s\]\([^)]+\)/g, '[语音]')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '[图片]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatNote(note: any): string {
  const meta = [`ID:${note.id}`, `类型:${note.type}`];
  if (note.todoStatus) meta.push(`状态:${note.todoStatus === 'done' ? '已完成' : '未完成'}`);
  if (note.category) meta.push(`分类:${note.category}`);
  if (note.tags?.length) meta.push(`标签:${(note.tags as string[]).join(',')}`);
  if (note.todoDue) meta.push(`截止:${note.todoDue}`);
  if (note.pinned) meta.push('置顶');
  meta.push(`创建:${note.createdAt?.slice(0, 10)}`);
  if (note.updatedAt && note.updatedAt !== note.createdAt) meta.push(`更新:${note.updatedAt.slice(0, 10)}`);
  const parts = [`[${meta.join(' | ')}]`];
  if (note.summary) parts.push(`摘要：${note.summary}`);
  parts.push(`内容：${cleanContent(note.content) || '(无正文)'}`);
  return parts.join('\n');
}

export async function executeTool(userId: string, name: string, args: any): Promise<{ result: string; noteIds: string[] }> {
  const noteIds: string[] = [];

  switch (name) {
    case 'search_notes': {
      const conditions: any[] = [eq(schema.notes.userId, userId), sql`${schema.notes.deletedAt} IS NULL`];
      if (args.query) {
        const q = `%${args.query}%`;
        // 同时搜 content / summary / tags，避免 label 在标题/摘要里但内容里没有的情况漏检
        conditions.push(or(
          like(schema.notes.content, q),
          like(schema.notes.summary, q),
          like(schema.notes.tags, q),
        )!);
      }
      if (args.type) conditions.push(eq(schema.notes.type, args.type));
      if (args.category) conditions.push(like(schema.notes.category, `%${args.category}%`));
      if (args.tags) {
        for (const t of args.tags.split(',')) {
          conditions.push(like(schema.notes.tags, `%"${t.trim()}"%`));
        }
      }
      if (args.dateFrom) conditions.push(sql`${schema.notes.createdAt} >= ${args.dateFrom}`);
      if (args.dateTo) conditions.push(sql`${schema.notes.createdAt} <= ${args.dateTo + 'T23:59:59.999Z'}`);

      const notes = await db.select().from(schema.notes)
        .where(and(...conditions))
        .orderBy(desc(schema.notes.createdAt))
        .limit(args.limit || 10)
        .all();

      notes.forEach(n => noteIds.push(n.id));
      if (!notes.length) return { result: '未找到匹配的笔记。', noteIds };
      return { result: `找到 ${notes.length} 条笔记：\n\n${notes.map(formatNote).join('\n\n---\n\n')}`, noteIds };
    }

    case 'get_note': {
      const note = await db.select().from(schema.notes)
        .where(and(eq(schema.notes.id, args.id), eq(schema.notes.userId, userId))).get();
      if (!note) return { result: '笔记不存在或已删除。', noteIds };
      noteIds.push(note.id);
      return { result: formatNote(note), noteIds };
    }

    case 'get_todos': {
      const conditions: any[] = [eq(schema.notes.userId, userId), eq(schema.notes.type, 'todo'), sql`${schema.notes.deletedAt} IS NULL`];
      if (args.status && args.status !== 'all') conditions.push(eq(schema.notes.todoStatus, args.status));
      const todos = await db.select().from(schema.notes)
        .where(and(...conditions))
        .orderBy(desc(schema.notes.createdAt))
        .limit(args.limit || 20)
        .all();
      todos.forEach(n => noteIds.push(n.id));
      if (!todos.length) return { result: '没有找到待办事项。', noteIds };
      // 直接算好数量塞进返回，弱模型不擅长数数
      const doneCount = todos.filter(t => t.todoStatus === 'done').length;
      const pendingCount = todos.length - doneCount;
      const header = args.status === 'pending'
        ? `共 ${todos.length} 条未完成待办：`
        : args.status === 'done'
        ? `共 ${todos.length} 条已完成待办：`
        : `共 ${todos.length} 条待办（已完成 ${doneCount} 条 / 未完成 ${pendingCount} 条）：`;
      return { result: `${header}\n\n${todos.map(formatNote).join('\n\n---\n\n')}`, noteIds };
    }

    case 'get_recent_notes': {
      const conditions: any[] = [eq(schema.notes.userId, userId), sql`${schema.notes.deletedAt} IS NULL`];
      if (args.type) conditions.push(eq(schema.notes.type, args.type));
      const notes = await db.select().from(schema.notes)
        .where(and(...conditions))
        .orderBy(desc(schema.notes.createdAt))
        .limit(args.limit || 10)
        .all();
      notes.forEach(n => noteIds.push(n.id));
      if (!notes.length) return { result: '暂无笔记。', noteIds };
      return { result: `最近 ${notes.length} 条笔记：\n\n${notes.map(formatNote).join('\n\n---\n\n')}`, noteIds };
    }

    case 'get_categories': {
      const cats = await db.select().from(schema.categories)
        .where(eq(schema.categories.userId, userId)).all();
      if (!cats.length) return { result: '暂无分类。', noteIds };
      return { result: `分类列表：${cats.map(c => c.name).join('、')}`, noteIds };
    }

    case 'get_tags': {
      const notes = await db.select({ tags: schema.notes.tags }).from(schema.notes)
        .where(and(eq(schema.notes.userId, userId), sql`${schema.notes.deletedAt} IS NULL`)).all();
      const tagSet = new Set<string>();
      notes.forEach(n => (n.tags as string[])?.forEach(t => tagSet.add(t)));
      const tags = [...tagSet].sort();
      if (!tags.length) return { result: '暂无标签。', noteIds };
      return { result: `标签列表：${tags.join('、')}`, noteIds };
    }

    case 'get_stats': {
      const total = db.select({ count: sql<number>`count(*)` }).from(schema.notes)
        .where(and(eq(schema.notes.userId, userId), sql`${schema.notes.deletedAt} IS NULL`)).get();
      const todos = db.select({ count: sql<number>`count(*)` }).from(schema.notes)
        .where(and(eq(schema.notes.userId, userId), eq(schema.notes.type, 'todo'), sql`${schema.notes.deletedAt} IS NULL`)).get();
      const pending = db.select({ count: sql<number>`count(*)` }).from(schema.notes)
        .where(and(eq(schema.notes.userId, userId), eq(schema.notes.type, 'todo'), eq(schema.notes.todoStatus, 'pending'), sql`${schema.notes.deletedAt} IS NULL`)).get();
      return {
        result: `笔记统计：总笔记 ${total?.count || 0} 条，待办 ${todos?.count || 0} 条（未完成 ${pending?.count || 0} 条）`,
        noteIds,
      };
    }

    case 'get_voice_transcription': {
      const trans = await db.select().from(schema.voiceTranscriptions)
        .where(and(eq(schema.voiceTranscriptions.userId, userId), eq(schema.voiceTranscriptions.audioUrl, args.audioUrl))).get();
      if (!trans) return { result: '未找到该语音的转写记录。', noteIds };
      if (trans.status === 'done') return { result: `语音转写内容：${trans.text}`, noteIds };
      return { result: `语音转写状态：${trans.status}`, noteIds };
    }

    case 'create_note': {
      const id = nanoid(12);
      const now = dayjs().toISOString();
      await db.insert(schema.notes).values({
        id, userId, content: args.content, type: args.type || 'note',
        category: args.category || null, tags: args.tags || [],
        todoStatus: args.type === 'todo' ? 'pending' : null,
        aiProcessed: false, pinned: false, createdAt: now, updatedAt: now,
      });
      noteIds.push(id);
      return { result: `已创建${args.type === 'todo' ? '待办' : '笔记'}：${args.content.slice(0, 50)}。直接告诉用户已完成，不要调用其他工具。`, noteIds };
    }

    case 'update_note': {
      const note = await db.select().from(schema.notes)
        .where(and(eq(schema.notes.id, args.id), eq(schema.notes.userId, userId))).get();
      if (!note) return { result: '笔记不存在。', noteIds };

      const updates: Record<string, any> = { updatedAt: dayjs().toISOString() };
      if (args.content !== undefined) updates.content = args.content;
      if (args.category !== undefined) updates.category = args.category;
      if (args.tags !== undefined) updates.tags = args.tags;
      if (args.todoStatus !== undefined) updates.todoStatus = args.todoStatus;
      if (args.pinned !== undefined) updates.pinned = args.pinned;

      await db.update(schema.notes).set(updates).where(eq(schema.notes.id, args.id));
      noteIds.push(args.id);
      const actions = [];
      if (args.todoStatus === 'done') actions.push('标记为完成');
      if (args.todoStatus === 'pending') actions.push('标记为未完成');
      if (args.pinned === true) actions.push('已置顶');
      if (args.pinned === false) actions.push('已取消置顶');
      if (args.content) actions.push('内容已更新');
      return { result: `笔记${actions.join('，') || '已更新'}。直接告诉用户已完成，不要调用其他工具。`, noteIds };
    }

    default:
      return { result: `未知工具: ${name}`, noteIds };
  }
}

// ── 提示词降级模式：工具描述文本 ──

export const TOOLS_PROMPT = `你可以使用以下工具来查询和操作用户的笔记数据。当你需要获取数据时，使用 <tool> 标签调用工具：

<tool>{"name":"工具名","args":{"参数名":"值"}}</tool>

系统会执行工具并返回结果，然后你再根据结果回答用户。

可用工具：
1. search_notes(query?, type?, category?, tags?, dateFrom?, dateTo?, limit?) — 搜索笔记
2. get_note(id) — 获取单条笔记全文
3. get_todos(status?, limit?) — 获取待办列表，status可选 pending/done/all
4. get_recent_notes(type?, limit?) — 获取最近笔记
5. get_categories() — 获取所有分类
6. get_tags() — 获取所有标签
7. get_stats() — 获取统计数据
8. get_voice_transcription(audioUrl) — 获取语音转写
9. create_note(content, type?, category?, tags?) — 创建笔记/待办
10. update_note(id, content?, category?, tags?, todoStatus?, pinned?) — 更新笔记

示例：用户问"总结一下未完成的待办"，你应该先调用：
<tool>{"name":"get_todos","args":{"status":"pending"}}</tool>
等待结果后再回答。`;
