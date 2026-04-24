import { Hono } from 'hono';
import { db, schema } from '../db/index.js';
import { eq, and, desc, sql, like, or, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { authMiddleware } from '../auth.js';
import dayjs from 'dayjs';
import { getConfigForFeature, callAiWithToolLoop, type ChatMessage } from '../ai/client.js';
import { DEFAULT_PROMPTS, AI_PERSONAS } from '../ai/prompts.js';
import { estimateTokens } from '../ai/context.js';
import { TOOL_DEFINITIONS, TOOLS_PROMPT, executeTool } from '../ai/tools.js';

const app = new Hono();
app.use('*', authMiddleware);

// GET /conversations — 对话列表
app.get('/conversations', async (c) => {
  const userId = c.get('userId');
  const search = c.req.query('search')?.trim();

  if (search) {
    const msgMatches = await db.selectDistinct({ conversationId: schema.aiMessages.conversationId })
      .from(schema.aiMessages)
      .where(like(schema.aiMessages.content, `%${search}%`))
      .all();
    const msgConvIds = msgMatches.map(m => m.conversationId);

    const titleMatch = like(schema.aiConversations.title, `%${search}%`);
    const condition = msgConvIds.length
      ? and(eq(schema.aiConversations.userId, userId), or(titleMatch, inArray(schema.aiConversations.id, msgConvIds)))
      : and(eq(schema.aiConversations.userId, userId), titleMatch);

    const rows = await db.select().from(schema.aiConversations)
      .where(condition)
      .orderBy(desc(schema.aiConversations.updatedAt))
      .limit(50)
      .all();
    return c.json({ data: rows });
  }

  const conversations = await db.select().from(schema.aiConversations)
    .where(eq(schema.aiConversations.userId, userId))
    .orderBy(desc(schema.aiConversations.updatedAt))
    .limit(50)
    .all();
  return c.json({ data: conversations });
});

// POST /conversations — 新建对话
app.post('/conversations', async (c) => {
  const userId = c.get('userId');
  const id = nanoid(12);
  const now = dayjs().toISOString();
  const conv = { id, userId, title: '新对话', createdAt: now, updatedAt: now };
  await db.insert(schema.aiConversations).values(conv);
  return c.json({ data: conv }, 201);
});

// PATCH /conversations/:id — 更新标题
app.patch('/conversations/:id', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  const { title } = await c.req.json();
  const conv = await db.select().from(schema.aiConversations)
    .where(and(eq(schema.aiConversations.id, id), eq(schema.aiConversations.userId, userId))).get();
  if (!conv) return c.json({ error: '对话不存在' }, 404);
  await db.update(schema.aiConversations).set({ title }).where(eq(schema.aiConversations.id, id));
  return c.json({ data: { id, title } });
});

// DELETE /conversations/:id — 删除对话（级联删消息）
app.delete('/conversations/:id', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  const conv = await db.select().from(schema.aiConversations)
    .where(and(eq(schema.aiConversations.id, id), eq(schema.aiConversations.userId, userId))).get();
  if (!conv) return c.json({ error: '对话不存在' }, 404);
  await db.delete(schema.aiMessages).where(eq(schema.aiMessages.conversationId, id));
  await db.delete(schema.aiConversations).where(eq(schema.aiConversations.id, id));
  return c.json({ message: '已删除' });
});

// GET /conversations/:id/messages — 获取消息
app.get('/conversations/:id/messages', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  const conv = await db.select().from(schema.aiConversations)
    .where(and(eq(schema.aiConversations.id, id), eq(schema.aiConversations.userId, userId))).get();
  if (!conv) return c.json({ error: '对话不存在' }, 404);

  const messages = await db.select().from(schema.aiMessages)
    .where(eq(schema.aiMessages.conversationId, id))
    .orderBy(schema.aiMessages.createdAt)
    .all();
  return c.json({ data: messages });
});

// POST /conversations/:id/messages — 发送消息 + Function Calling + SSE 流式回复
app.post('/conversations/:id/messages', async (c) => {
  const userId = c.get('userId');
  const { id } = c.req.param();
  const { question } = await c.req.json();
  if (!question?.trim()) return c.json({ error: '请输入问题' }, 400);

  const conv = await db.select().from(schema.aiConversations)
    .where(and(eq(schema.aiConversations.id, id), eq(schema.aiConversations.userId, userId))).get();
  if (!conv) return c.json({ error: '对话不存在' }, 404);

  const config = await getConfigForFeature(userId, 'chat');
  if (!config) return c.json({ error: '未配置 AI 模型，请在设置中添加 AI 配置' }, 400);

  // 保存用户消息
  const userMsgId = nanoid(12);
  const now = dayjs().toISOString();
  await db.insert(schema.aiMessages).values({
    id: userMsgId, conversationId: id, role: 'user', content: question, sources: [], createdAt: now,
  });
  await db.update(schema.aiConversations).set({ updatedAt: now }).where(eq(schema.aiConversations.id, id));

  // 获取用户设置
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const prefs = (user as any)?.preferences || {};
  const maxTokens = prefs.aiChatMaxTokens || 8192;
  const budget = maxTokens - 2048;

  // system prompt + 人格
  const userPrompt = await db.select().from(schema.aiPrompts)
    .where(and(eq(schema.aiPrompts.userId, userId), eq(schema.aiPrompts.feature, 'chat'))).get();
  const basePrompt = userPrompt?.prompt || DEFAULT_PROMPTS.chat;
  const personaKey = prefs.aiPersona || 'concise';
  const persona = personaKey === 'custom'
    ? (prefs.aiPersonaCustom || '')
    : (AI_PERSONAS[personaKey]?.prompt || AI_PERSONAS.concise.prompt);
  let systemContent = `${basePrompt}\n\n${persona}`;

  // 加载历史消息 + token 裁剪
  let usedTokens = estimateTokens(systemContent) + estimateTokens(question);
  const history = await db.select().from(schema.aiMessages)
    .where(eq(schema.aiMessages.conversationId, id))
    .orderBy(desc(schema.aiMessages.createdAt))
    .all();
  const pastMessages = history.filter(m => m.id !== userMsgId);
  const selectedHistory: ChatMessage[] = [];
  for (const msg of pastMessages) {
    const msgTokens = estimateTokens(typeof msg.content === 'string' ? msg.content : '');
    if (usedTokens + msgTokens > budget) break;
    usedTokens += msgTokens;
    selectedHistory.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
  }
  selectedHistory.reverse();

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    ...selectedHistory,
    { role: 'user', content: question },
  ];

  // SSE 响应
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (obj: any) => writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  (async () => {
    try {
      const { stream: aiStream, noteIds } = await callAiWithToolLoop(
        config, messages, TOOL_DEFINITIONS,
        (name, args) => executeTool(userId, name, args),
        (event) => { write({ type: 'tool_call', name: event.name, args: event.args }); },
      );

      const reader = aiStream.getReader();
      let fullResponse = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullResponse += value;
        await write({ type: 'delta', content: value });
      }

      // 保存 AI 回复
      const aiMsgId = nanoid(12);
      await db.insert(schema.aiMessages).values({
        id: aiMsgId, conversationId: id, role: 'assistant', content: fullResponse,
        sources: noteIds, createdAt: dayjs().toISOString(),
      });
      await write({ type: 'done', sources: noteIds, messageId: aiMsgId });

      // 首轮自动生成标题
      const msgCount = await db.select({ count: sql`count(*)` }).from(schema.aiMessages)
        .where(eq(schema.aiMessages.conversationId, id)).get();
      if ((msgCount as any)?.count <= 2 && conv.title === '新对话') {
        try {
          const titlePrompt = `根据以下对话生成一个5-10字的简短标题，只返回标题文字：\n用户：${question}\nAI：${fullResponse.slice(0, 200)}`;
          const titleHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (config.provider === 'anthropic') {
            titleHeaders['x-api-key'] = config.apiKey || '';
            titleHeaders['anthropic-version'] = '2023-06-01';
            const base = config.baseUrl.replace(/\/+$/, '');
            const ep = base.includes('/v1/messages') ? base : base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
            const res = await fetch(ep, { method: 'POST', headers: titleHeaders, body: JSON.stringify({ model: config.model, max_tokens: 30, messages: [{ role: 'user', content: titlePrompt }] }) });
            if (res.ok) { const d = await res.json() as any; const t = d.content?.[0]?.text?.trim().slice(0, 20); if (t) { await db.update(schema.aiConversations).set({ title: t }).where(eq(schema.aiConversations.id, id)); await write({ type: 'title', title: t }); } }
          } else {
            if (config.apiKey) titleHeaders['Authorization'] = `Bearer ${config.apiKey}`;
            const base = config.baseUrl.replace(/\/+$/, '');
            const ep = base.includes('/chat/completions') ? base : base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
            const res = await fetch(ep, { method: 'POST', headers: titleHeaders, body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: titlePrompt }], max_tokens: 30, temperature: 0.3 }) });
            if (res.ok) { const d = await res.json() as any; const t = d.choices?.[0]?.message?.content?.trim().slice(0, 20); if (t) { await db.update(schema.aiConversations).set({ title: t }).where(eq(schema.aiConversations.id, id)); await write({ type: 'title', title: t }); } }
          }
        } catch {}
      }
    } catch (err: any) {
      console.error('[AI Chat] error:', err);
      await write({ type: 'error', error: err.message || 'AI 调用失败' });
    } finally {
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
});

export default app;
