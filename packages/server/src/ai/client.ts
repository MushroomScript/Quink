import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { DEFAULT_PROMPTS, type AiFeature } from './prompts.js';

interface AiCallOptions {
  userId: string;
  feature: AiFeature;
  content: string;
  context?: string; // for chat RAG
}

interface AiConfig {
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

/**
 * Get the AI config bound to a feature for a user.
 * Returns null if no config is bound.
 */
async function getConfigForFeature(userId: string, feature: AiFeature): Promise<AiConfig | null> {
  // Get user preferences to find binding
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user) return null;

  const prefs = (user.preferences as Record<string, any>) || {};
  const bindings = prefs.aiBindings || {};
  const configId = bindings[feature];

  if (!configId) {
    // Fallback: use default config
    const defaultConfig = await db.select().from(schema.aiConfigs)
      .where(and(eq(schema.aiConfigs.userId, userId), eq(schema.aiConfigs.isDefault, true))).get();
    if (!defaultConfig) {
      // Fallback: use first config
      const first = await db.select().from(schema.aiConfigs)
        .where(eq(schema.aiConfigs.userId, userId)).get();
      return first || null;
    }
    return defaultConfig;
  }

  const config = await db.select().from(schema.aiConfigs)
    .where(and(eq(schema.aiConfigs.id, configId), eq(schema.aiConfigs.userId, userId))).get();
  return config || null;
}

/**
 * Get the prompt for a feature (user custom or default).
 */
async function getPrompt(userId: string, feature: AiFeature): Promise<string> {
  const custom = await db.select().from(schema.aiPrompts)
    .where(and(eq(schema.aiPrompts.userId, userId), eq(schema.aiPrompts.feature, feature))).get();
  return custom?.prompt || DEFAULT_PROMPTS[feature];
}

/**
 * Call an AI model with the given prompt and content.
 */
/**
 * 智能拼接 API 地址。
 * 用户随便填什么格式都能自动拼对：
 *   https://api.openai.com          → /v1/chat/completions
 *   https://api.openai.com/v1       → /chat/completions
 *   https://api.openai.com/v1/      → /chat/completions
 *   https://api.anthropic.com       → /v1/messages
 *   https://api.anthropic.com/v1    → /messages
 *   http://localhost:11434          → /v1/chat/completions
 *   http://localhost:11434/v1       → /chat/completions
 */
function buildEndpoint(config: AiConfig): string {
  let base = config.baseUrl.replace(/\/+$/, '');

  if (config.provider === 'anthropic') {
    // 已经有完整路径
    if (base.includes('/v1/messages')) return base;
    if (base.endsWith('/v1')) return `${base}/messages`;
    return `${base}/v1/messages`;
  }

  // OpenAI / Ollama / custom — 全部走 OpenAI 兼容格式
  if (base.includes('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

async function callAi(config: AiConfig, systemPrompt: string, userMessage: string): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const endpoint = buildEndpoint(config);

  if (config.provider === 'anthropic') {
    headers['x-api-key'] = config.apiKey || '';
    headers['anthropic-version'] = '2023-06-01';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
    const data = await res.json() as any;
    return data.content?.[0]?.text || '';
  } else {
    // OpenAI-compatible (openai, ollama, custom)
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 1024,
        temperature: 0.3,
      }),
    });

    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }
}

/**
 * Clean content for AI. Now content is Markdown, just trim it.
 * Also strips HTML tags for backwards compatibility with old notes.
 */
function cleanContent(content: string): string {
  return content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Run auto-tag on a note. Returns tags array.
 */
export async function autoTag(userId: string, content: string): Promise<string[]> {
  const config = await getConfigForFeature(userId, 'auto_tag');
  if (!config) return [];

  const prompt = await getPrompt(userId, 'auto_tag');
  const text = cleanContent(content);
  if (text.length < 5) return []; // too short

  try {
    const result = await callAi(config, '你是一个标签提取助手，只返回JSON数组。', prompt.replace('{content}', text));
    // Parse JSON array from response
    const match = result.match(/\[[\s\S]*?\]/);
    if (match) {
      const tags = JSON.parse(match[0]);
      if (Array.isArray(tags)) return tags.map(String).slice(0, 5);
    }
    return [];
  } catch (err) {
    console.error('Auto-tag failed:', err);
    return [];
  }
}

/**
 * Run auto-classify on a note. Returns category string.
 */
export async function autoClassify(userId: string, content: string): Promise<string | null> {
  const config = await getConfigForFeature(userId, 'auto_classify');
  if (!config) return null;

  const prompt = await getPrompt(userId, 'auto_classify');
  const text = cleanContent(content);
  if (text.length < 5) return null;

  try {
    const result = await callAi(config, '你是一个分类助手，只返回分类名称。', prompt.replace('{content}', text));
    return result.trim().replace(/["""]/g, '') || null;
  } catch (err) {
    console.error('Auto-classify failed:', err);
    return null;
  }
}

/**
 * Generate a one-line summary for a note.
 */
export async function autoSummary(userId: string, content: string): Promise<string | null> {
  const config = await getConfigForFeature(userId, 'auto_tag'); // 复用标签的配置（便宜模型）
  if (!config) return null;

  const text = cleanContent(content);
  if (text.length < 20) return null;

  try {
    const result = await callAi(config,
      '你是一个摘要助手，用一句话（不超过30字）概括以下内容的核心。只返回摘要文本，不要加引号或其他标记。',
      text
    );
    return result.trim().slice(0, 50) || null;
  } catch (err) {
    console.error('Auto-summary failed:', err);
    return null;
  }
}

/**
 * Generic AI call for polish/expand/write features.
 */
export async function aiProcess(userId: string, feature: AiFeature, content: string, customPrompt?: string): Promise<string> {
  const config = await getConfigForFeature(userId, feature);
  if (!config) throw new Error('未配置 AI 模型，请在设置中添加 AI 配置');

  const prompt = customPrompt || await getPrompt(userId, feature);
  const text = cleanContent(content);

  const result = await callAi(config, '你是一个写作助手。', prompt.replace('{content}', text));
  return result;
}

/**
 * AI chat with context (for RAG).
 */
export async function aiChat(userId: string, question: string, context: string): Promise<string> {
  const config = await getConfigForFeature(userId, 'chat');
  if (!config) throw new Error('未配置 AI 模型，请在设置中添加 AI 配置');

  const prompt = await getPrompt(userId, 'chat');
  const filledPrompt = prompt.replace('{context}', context).replace('{content}', question);

  const result = await callAi(config, filledPrompt, question);
  return result;
}
