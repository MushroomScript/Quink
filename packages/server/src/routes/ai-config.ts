import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { authMiddleware } from '../auth.js';
import { publish } from '../reminder/bus.js';
import crypto from 'crypto';
import dayjs from 'dayjs';
import { DEFAULT_PROMPTS, AI_FEATURES, AI_FEATURE_LABELS } from '../ai/prompts.js';
import { aiProcess } from '../ai/client.js';
import { UPLOAD_DIR } from '../config/paths.js';

const app = new Hono();
app.use('*', authMiddleware);

// ── AI Configs CRUD ──

const configSchema = z.object({
  name: z.string().min(1).max(50),
  provider: z.enum(['openai', 'anthropic', 'ollama']),
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  isDefault: z.boolean().optional(),
});

// List configs
app.get('/configs', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const configs = await db.select().from(schema.aiConfigs)
    .where(eq(schema.aiConfigs.userId, userId)).all();
  return c.json({ data: configs });
});

// Create config
app.post('/configs', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const body = await c.req.json();
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // 写入时校验 baseUrl 防 SSRF. 一次校验, 运行时直接 fetch 不再校验 (性能)
  const { validateOutboundUrl } = await import('../utils/urlGuard.js');
  const guard = await validateOutboundUrl(parsed.data.baseUrl);
  if (!guard.ok) return c.json({ error: `baseUrl 不安全: ${guard.reason}` }, 400);

  const id = nanoid(12);

  // If first config or marked as default, ensure only one default
  const existing = await db.select().from(schema.aiConfigs)
    .where(eq(schema.aiConfigs.userId, userId)).all();
  const isDefault = parsed.data.isDefault || existing.length === 0;

  if (isDefault) {
    await db.update(schema.aiConfigs)
      .set({ isDefault: false })
      .where(eq(schema.aiConfigs.userId, userId));
  }

  const config = {
    id,
    userId,
    name: parsed.data.name,
    provider: parsed.data.provider,
    baseUrl: parsed.data.baseUrl,
    apiKey: parsed.data.apiKey ?? null,
    model: parsed.data.model,
    isDefault,
    createdAt: dayjs().toISOString(),
  };

  await db.insert(schema.aiConfigs).values(config);
  publish(userId, 'data-changed', { scope: 'ai-configs' }, _ocid);
  const { logAudit } = await import('../utils/auditLog.js');
  await logAudit(c, 'ai.config_create', 'ai_config', config.id, {
    name: config.name, provider: config.provider, model: config.model,
  });
  return c.json({ data: config }, 201);
});

// Update config
app.patch('/configs/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  const body = await c.req.json();
  const parsed = configSchema.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const existing = await db.select().from(schema.aiConfigs)
    .where(and(eq(schema.aiConfigs.id, id), eq(schema.aiConfigs.userId, userId))).get();
  if (!existing) return c.json({ error: '配置不存在' }, 404);

  // 改 baseUrl 时复跑校验
  if (parsed.data.baseUrl !== undefined && parsed.data.baseUrl !== existing.baseUrl) {
    const { validateOutboundUrl } = await import('../utils/urlGuard.js');
    const guard = await validateOutboundUrl(parsed.data.baseUrl);
    if (!guard.ok) return c.json({ error: `baseUrl 不安全: ${guard.reason}` }, 400);
  }

  const updates: Record<string, any> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.provider !== undefined) updates.provider = parsed.data.provider;
  if (parsed.data.baseUrl !== undefined) updates.baseUrl = parsed.data.baseUrl;
  if (parsed.data.apiKey !== undefined) updates.apiKey = parsed.data.apiKey;
  if (parsed.data.model !== undefined) updates.model = parsed.data.model;

  if (parsed.data.isDefault) {
    await db.update(schema.aiConfigs).set({ isDefault: false }).where(eq(schema.aiConfigs.userId, userId));
    updates.isDefault = true;
  }

  await db.update(schema.aiConfigs).set(updates).where(eq(schema.aiConfigs.id, id));

  const updated = await db.select().from(schema.aiConfigs).where(eq(schema.aiConfigs.id, id)).get();
  publish(userId, 'data-changed', { scope: 'ai-configs' }, _ocid);
  const { logAudit } = await import('../utils/auditLog.js');
  await logAudit(c, 'ai.config_update', 'ai_config', id, { fields: Object.keys(updates) });
  return c.json({ data: updated });
});

// Delete config
app.delete('/configs/:id', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { id } = c.req.param();
  const existing = await db.select().from(schema.aiConfigs)
    .where(and(eq(schema.aiConfigs.id, id), eq(schema.aiConfigs.userId, userId))).get();
  if (!existing) return c.json({ error: '配置不存在' }, 404);

  await db.delete(schema.aiConfigs).where(eq(schema.aiConfigs.id, id));
  publish(userId, 'data-changed', { scope: 'ai-configs' }, _ocid);
  const { logAudit } = await import('../utils/auditLog.js');
  await logAudit(c, 'ai.config_delete', 'ai_config', id, { name: existing.name });
  return c.json({ message: '已删除' });
});

// ── AI Prompts ──

// Get all prompts (returns defaults merged with user customizations)
app.get('/prompts', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const userPrompts = await db.select().from(schema.aiPrompts)
    .where(eq(schema.aiPrompts.userId, userId)).all();

  const promptMap = new Map(userPrompts.map(p => [p.feature, p.prompt]));
  const result: Record<string, { feature: string; label: string; prompt: string; isCustom: boolean }> = {};

  for (const feature of AI_FEATURES) {
    result[feature] = {
      feature,
      label: AI_FEATURE_LABELS[feature],
      prompt: promptMap.get(feature) || DEFAULT_PROMPTS[feature],
      isCustom: promptMap.has(feature),
    };
  }

  return c.json({ data: result });
});

// Update prompt for a feature
app.patch('/prompts/:feature', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { feature } = c.req.param();
  if (!AI_FEATURES.includes(feature as any)) {
    return c.json({ error: '未知功能' }, 400);
  }

  const { prompt } = await c.req.json();
  if (!prompt || typeof prompt !== 'string') {
    return c.json({ error: '提示词不能为空' }, 400);
  }

  const existing = await db.select().from(schema.aiPrompts)
    .where(and(eq(schema.aiPrompts.userId, userId), eq(schema.aiPrompts.feature, feature))).get();

  if (existing) {
    await db.update(schema.aiPrompts)
      .set({ prompt, updatedAt: dayjs().toISOString() })
      .where(eq(schema.aiPrompts.id, existing.id));
  } else {
    await db.insert(schema.aiPrompts).values({
      id: nanoid(12),
      userId,
      feature,
      prompt,
      updatedAt: dayjs().toISOString(),
    });
  }

  publish(userId, 'data-changed', { scope: 'ai-prompts' }, _ocid);
  return c.json({ data: { feature, prompt } });
});

// Reset prompt to default
app.delete('/prompts/:feature', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { feature } = c.req.param();

  await db.delete(schema.aiPrompts)
    .where(and(eq(schema.aiPrompts.userId, userId), eq(schema.aiPrompts.feature, feature)));

  publish(userId, 'data-changed', { scope: 'ai-prompts' }, _ocid);
  return c.json({ data: { feature, prompt: DEFAULT_PROMPTS[feature as keyof typeof DEFAULT_PROMPTS] } });
});

// ── Test Config ──
// 校验 baseUrl 防 SSRF (用户可能填 internal 地址让 server 代为请求, 且 apiKey 会作为 Authorization 头送到该地址).
// 同时错误信息脱敏防内网探测
app.post('/test', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { configId } = await c.req.json();

  const config = await db.select().from(schema.aiConfigs)
    .where(and(eq(schema.aiConfigs.id, configId), eq(schema.aiConfigs.userId, userId))).get();
  if (!config) return c.json({ error: '配置不存在' }, 404);

  // SSRF 校验
  const { validateOutboundUrl, sanitizeFetchError } = await import('../utils/urlGuard.js');
  const guard = await validateOutboundUrl(config.baseUrl);
  if (!guard.ok) return c.json({ data: { success: false, message: `配置不安全: ${guard.reason}` } });

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let base = config.baseUrl.replace(/\/+$/, '');

    if (config.provider === 'anthropic') {
      const endpoint = base.includes('/v1/messages') ? base : base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
      headers['x-api-key'] = config.apiKey || '';
      headers['anthropic-version'] = '2023-06-01';
      const res = await fetch(endpoint, {
        method: 'POST', headers,
        body: JSON.stringify({ model: config.model, max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else {
      const endpoint = base.includes('/chat/completions') ? base : base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
      const res = await fetch(endpoint, {
        method: 'POST', headers,
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 10 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }

    return c.json({ data: { success: true, message: '连接成功' } });
  } catch (err: any) {
    // 错误脱敏: 不返回 ECONNREFUSED 等防内网探测
    const friendly = err.message?.startsWith('HTTP ') ? err.message : sanitizeFetchError(err);
    return c.json({ data: { success: false, message: `连接失败: ${friendly}` } });
  }
});

// ── AI Process (polish/expand/write) ──
app.post('/process', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { feature, content, prompt: customPrompt } = await c.req.json();

  if (!AI_FEATURES.includes(feature)) return c.json({ error: '未知功能' }, 400);
  if (!content?.trim()) return c.json({ error: '内容不能为空' }, 400);

  try {
    const result = await aiProcess(userId, feature, content, customPrompt || undefined);
    return c.json({ data: { result } });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /api/ai/transcribe — 语音转文字
app.post('/transcribe', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    if (!file) return c.json({ error: '缺少音频文件' }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    const { transcribeAudio } = await import('../ai/client.js');
    const text = await transcribeAudio(userId, buffer, file.type);
    return c.json({ data: { text } });
  } catch (err: any) {
    return c.json({ error: err.message || '语音识别失败' }, 500);
  }
});

// GET /api/ai/iat-url — 讯飞语音听写鉴权 URL
app.get('/iat-url', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const prefs = (user as any)?.preferences || {};
  const xf = prefs.xfyun || {};
  if (!xf.appId || !xf.apiKey || !xf.apiSecret) {
    return c.json({ error: '未配置讯飞语音' }, 400);
  }

  const host = 'iat-api.xfyun.cn';
  const date = new Date().toUTCString();
  const requestLine = 'GET /v2/iat HTTP/1.1';
  const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
  const signature = crypto.createHmac('sha256', xf.apiSecret)
    .update(signatureOrigin).digest('base64');
  const authorizationOrigin = `api_key="${xf.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  const url = `wss://${host}/v2/iat?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${host}`;

  return c.json({ data: { url, appId: xf.appId } });
});

// POST /api/ai/transcribe-async — 异步转写语音（录音保存时调用）
app.post('/transcribe-async', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const { audioUrl } = await c.req.json();
  if (!audioUrl) return c.json({ error: '缺少 audioUrl' }, 400);

  const existing = await db.select().from(schema.voiceTranscriptions)
    .where(and(eq(schema.voiceTranscriptions.userId, userId), eq(schema.voiceTranscriptions.audioUrl, audioUrl))).get();
  if (existing) return c.json({ data: existing });

  const id = nanoid(12);
  const record = { id, userId, audioUrl, text: '', status: 'pending' as const, createdAt: dayjs().toISOString() };
  await db.insert(schema.voiceTranscriptions).values(record);

  // 后台异步转写（不阻塞响应）
  (async () => {
    try {
      const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
      const prefs = (user as any)?.preferences || {};
      const xf = prefs.xfyun || {};
      if (!xf.appId || !xf.apiKey || !xf.apiSecret) {
        await db.update(schema.voiceTranscriptions).set({ status: 'failed', text: '未配置讯飞语音' }).where(eq(schema.voiceTranscriptions.id, id));
        return;
      }

      // 读音频文件: audioUrl 可能是裸名 "xxx.webm"(新格式) 或 "/api/uploads/xxx.webm"(老格式),
      // 剥掉前缀统一拿到磁盘文件名 → resolve 到 uploads 目录
      // path.basename 强制只取文件名防路径穿越 (../etc/passwd) + relative 校验 resolved path
      // 在 uploads 目录下兜底防符号链接 / Unicode 绕过
      const { resolve: pathResolve, basename, relative } = await import('path');
      const { readFileSync } = await import('fs');
      const stripped = audioUrl.replace(/^\/api\/uploads\//, '').replace(/^uploads\//, '');
      const filename = basename(stripped);  // 强制丢弃所有路径分隔符 / 上级引用
      if (!filename || filename.startsWith('.')) {
        throw new Error('非法 audioUrl');
      }
      const uploadDir = UPLOAD_DIR;
      const filePath = pathResolve(uploadDir, filename);
      // relative 兜底: 若 filePath 不在 uploadDir 内, relative 会返回以 ".." 开头的路径
      const rel = relative(uploadDir, filePath);
      if (rel.startsWith('..') || rel.includes('..')) {
        throw new Error('路径越界');
      }
      const buffer = readFileSync(filePath);

      const { transcribeAudio } = await import('../ai/client.js');
      const text = await transcribeAudio(userId, buffer, 'audio/webm');
      await db.update(schema.voiceTranscriptions).set({ status: 'done', text }).where(eq(schema.voiceTranscriptions.id, id));
    } catch (err: any) {
      await db.update(schema.voiceTranscriptions).set({ status: 'failed', text: err.message || '转写失败' }).where(eq(schema.voiceTranscriptions.id, id));
    }
  })();

  return c.json({ data: record }, 201);
});

// GET /api/ai/transcription — 查询转写结果
app.get('/transcription', async (c) => {
  const userId = c.get('userId');
  const _ocid = c.req.header('X-Quink-Client-Id');
  const audioUrl = c.req.query('audioUrl');
  if (!audioUrl) return c.json({ error: '缺少 audioUrl' }, 400);

  const record = await db.select().from(schema.voiceTranscriptions)
    .where(and(eq(schema.voiceTranscriptions.userId, userId), eq(schema.voiceTranscriptions.audioUrl, audioUrl))).get();
  return c.json({ data: record || null });
});

export default app;
