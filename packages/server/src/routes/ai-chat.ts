import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { db, schema } from '../db/index.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { authMiddleware } from '../auth.js';
import dayjs from 'dayjs';
import { getConfigForFeature, callAiStream, type ChatMessage } from '../ai/client.js';
import { DEFAULT_PROMPTS } from '../ai/prompts.js';
import { searchRelevantNotes, buildNoteContext, estimateTokens, readImageAsBase64 } from '../ai/context.js';

const app = new Hono();
app.use('*', authMiddleware);

// GET /conversations — 对话列表
app.get('/conversations', async (c) => {
  const userId = c.get('userId');
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

// POST /conversations/:id/messages — 发送消息 + SSE 流式回复
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
  const reserveTokens = 2048;
  const budget = maxTokens - reserveTokens;

  // 获取用户自定义 prompt 或默认
  const userPrompt = await db.select().from(schema.aiPrompts)
    .where(and(eq(schema.aiPrompts.userId, userId), eq(schema.aiPrompts.feature, 'chat'))).get();
  const systemPrompt = userPrompt?.prompt || DEFAULT_PROMPTS.chat;

  // 搜索相关笔记
  const relevantNotes = await searchRelevantNotes(userId, question, 8);
  const isMultimodal = config.provider === 'anthropic' || config.model.includes('vision') || config.model.includes('gpt-4o') || config.model.includes('gpt-4-turbo');
  const noteCtx = relevantNotes.length > 0
    ? await buildNoteContext(userId, relevantNotes, isMultimodal)
    : { text: '', imageUrls: [], noteIds: [] };

  // 构建 system 消息
  let systemContent = systemPrompt;
  if (noteCtx.text) {
    systemContent += `\n\n以下是用户相关的笔记内容：\n${noteCtx.text}`;
  }

  // token 预算分配
  let usedTokens = estimateTokens(systemContent) + estimateTokens(question);

  // 加载历史消息
  const history = await db.select().from(schema.aiMessages)
    .where(eq(schema.aiMessages.conversationId, id))
    .orderBy(desc(schema.aiMessages.createdAt))
    .all();
  // 去掉刚插入的用户消息
  const pastMessages = history.filter(m => m.id !== userMsgId).reverse();

  const historyMessages: ChatMessage[] = [];
  for (const msg of pastMessages.reverse()) {
    const msgTokens = estimateTokens(typeof msg.content === 'string' ? msg.content : '');
    if (usedTokens + msgTokens > budget) break;
    usedTokens += msgTokens;
    historyMessages.unshift({ role: msg.role as 'user' | 'assistant', content: msg.content });
  }
  historyMessages.reverse();

  // 构建最终 messages
  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    ...historyMessages.reverse(),
    { role: 'user', content: question },
  ];

  // 多模态：添加图片到用户消息
  if (isMultimodal && noteCtx.imageUrls.length > 0) {
    const imageContents: any[] = [{ type: 'text', text: question }];
    for (const imgUrl of noteCtx.imageUrls.slice(0, 5)) {
      const img = await readImageAsBase64(imgUrl);
      if (!img) continue;
      if (config.provider === 'anthropic') {
        imageContents.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
      } else {
        imageContents.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
      }
    }
    messages[messages.length - 1] = { role: 'user', content: imageContents };
  }

  // SSE 流式响应
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return stream(c, async (s) => {
    try {
      const aiStream = await callAiStream(config, messages, reserveTokens);
      const reader = aiStream.getReader();
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullResponse += value;
        await s.write(`data: ${JSON.stringify({ type: 'delta', content: value })}\n\n`);
      }

      // 保存 AI 回复
      const aiMsgId = nanoid(12);
      await db.insert(schema.aiMessages).values({
        id: aiMsgId, conversationId: id, role: 'assistant', content: fullResponse,
        sources: noteCtx.noteIds, createdAt: dayjs().toISOString(),
      });

      // 发送完成事件（含来源）
      await s.write(`data: ${JSON.stringify({ type: 'done', sources: noteCtx.noteIds, messageId: aiMsgId })}\n\n`);

      // 第一轮对话：自动生成标题
      const msgCount = await db.select({ count: sql`count(*)` }).from(schema.aiMessages)
        .where(eq(schema.aiMessages.conversationId, id)).get();
      if ((msgCount as any)?.count <= 2 && conv.title === '新对话') {
        try {
          const { default: callAiFn } = await import('../ai/client.js');
          const titlePrompt = `根据以下对话生成一个5-10字的简短标题，只返回标题文字：\n用户：${question}\nAI：${fullResponse.slice(0, 200)}`;
          const titleConfig = config;
          const titleHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (titleConfig.provider === 'anthropic') {
            titleHeaders['x-api-key'] = titleConfig.apiKey || '';
            titleHeaders['anthropic-version'] = '2023-06-01';
            const base = titleConfig.baseUrl.replace(/\/+$/, '');
            const ep = base.includes('/v1/messages') ? base : base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
            const res = await fetch(ep, { method: 'POST', headers: titleHeaders, body: JSON.stringify({ model: titleConfig.model, max_tokens: 30, messages: [{ role: 'user', content: titlePrompt }] }) });
            if (res.ok) { const d = await res.json() as any; const t = d.content?.[0]?.text?.trim().slice(0, 20); if (t) { await db.update(schema.aiConversations).set({ title: t }).where(eq(schema.aiConversations.id, id)); await s.write(`data: ${JSON.stringify({ type: 'title', title: t })}\n\n`); } }
          } else {
            if (titleConfig.apiKey) titleHeaders['Authorization'] = `Bearer ${titleConfig.apiKey}`;
            const base = titleConfig.baseUrl.replace(/\/+$/, '');
            const ep = base.includes('/chat/completions') ? base : base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
            const res = await fetch(ep, { method: 'POST', headers: titleHeaders, body: JSON.stringify({ model: titleConfig.model, messages: [{ role: 'user', content: titlePrompt }], max_tokens: 30, temperature: 0.3 }) });
            if (res.ok) { const d = await res.json() as any; const t = d.choices?.[0]?.message?.content?.trim().slice(0, 20); if (t) { await db.update(schema.aiConversations).set({ title: t }).where(eq(schema.aiConversations.id, id)); await s.write(`data: ${JSON.stringify({ type: 'title', title: t })}\n\n`); } }
          }
        } catch {}
      }
    } catch (err: any) {
      await s.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'AI 调用失败' })}\n\n`);
    }
  });
});

export default app;
