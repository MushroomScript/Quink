import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { DEFAULT_PROMPTS, type AiFeature } from './prompts.js';
import { TOOLS_PROMPT } from './tools.js';

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

  // OpenAI / Ollama — 全部走 OpenAI 兼容格式
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
    // OpenAI-compatible (openai, ollama)
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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string }; source?: { type: string; media_type: string; data: string } }>;
}

export async function callAiStream(config: AiConfig, messages: ChatMessage[], maxTokens = 2048): Promise<ReadableStream<string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const endpoint = buildEndpoint(config);

  if (config.provider === 'anthropic') {
    headers['x-api-key'] = config.apiKey || '';
    headers['anthropic-version'] = '2023-06-01';

    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        stream: true,
        system: typeof systemMsg?.content === 'string' ? systemMsg.content : '',
        messages: nonSystem.map(m => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);

    return new ReadableStream<string>({
      async start(controller) {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'content_block_delta' && data.delta?.text) {
                  controller.enqueue(data.delta.text);
                }
              } catch {}
            }
          }
        }
        controller.close();
      }
    });
  } else {
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: maxTokens,
        temperature: 0.3,
        stream: true,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);

    return new ReadableStream<string>({
      async start(controller) {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const data = JSON.parse(line.slice(6));
                const content = data.choices?.[0]?.delta?.content;
                if (content) controller.enqueue(content);
              } catch {}
            }
          }
        }
        controller.close();
      }
    });
  }
}

export { getConfigForFeature, buildEndpoint };

// ── Function Calling 工具调用循环 ──

interface ToolCallResult {
  toolCalls: { name: string; args: any; id: string }[];
}

async function callAiNonStream(config: AiConfig, messages: ChatMessage[], tools?: any[]): Promise<{ content: string | null; toolCalls: { name: string; args: any; id: string }[] }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const endpoint = buildEndpoint(config);

  if (config.provider === 'anthropic') {
    headers['x-api-key'] = config.apiKey || '';
    headers['anthropic-version'] = '2023-06-01';
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const body: any = {
      model: config.model, max_tokens: 2048,
      system: typeof systemMsg?.content === 'string' ? systemMsg.content : '',
      messages: nonSystem.map(m => ({ role: m.role, content: m.content })),
    };
    if (tools?.length) body.tools = tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    const textBlock = data.content?.find((b: any) => b.type === 'text');
    const toolBlocks = data.content?.filter((b: any) => b.type === 'tool_use') || [];
    return {
      content: textBlock?.text || null,
      toolCalls: toolBlocks.map((b: any) => ({ name: b.name, args: b.input, id: b.id })),
    };
  } else {
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    const body: any = {
      model: config.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: 2048, temperature: 0.3,
    };
    if (tools?.length) body.tools = tools;
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    const choice = data.choices?.[0]?.message;
    return {
      content: choice?.content || null,
      toolCalls: (choice?.tool_calls || []).map((tc: any) => ({
        name: tc.function.name,
        args: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments,
        id: tc.id,
      })),
    };
  }
}

export interface ToolCallEvent {
  name: string;
  args: any;
}

export async function callAiWithToolLoop(
  config: AiConfig,
  messages: ChatMessage[],
  tools: any[],
  executeToolFn: (name: string, args: any) => Promise<{ result: string; noteIds: string[] }>,
  onToolCall?: (event: ToolCallEvent) => void,
  maxRounds = 5,
): Promise<{ stream: ReadableStream<string>; noteIds: string[] }> {
  const allNoteIds: string[] = [];
  const msgsCopy = [...messages];
  let supportsTools = true;

  for (let round = 0; round < maxRounds; round++) {
    let response: { content: string | null; toolCalls: { name: string; args: any; id: string }[] };
    const t0 = Date.now();

    try {
      response = await callAiNonStream(config, msgsCopy, supportsTools ? tools : undefined);
    } catch (err: any) {
      if (err.message.includes('400') && supportsTools) {
        supportsTools = false;
        console.log(`[AI] round ${round}: FC not supported, falling back to prompt mode`);
        // 降级：把工具描述注入 system prompt
        const sysIdx = msgsCopy.findIndex(m => m.role === 'system');
        if (sysIdx >= 0 && typeof msgsCopy[sysIdx].content === 'string' && !(msgsCopy[sysIdx].content as string).includes('可用工具')) {
          msgsCopy[sysIdx] = { ...msgsCopy[sysIdx], content: msgsCopy[sysIdx].content + '\n\n' + TOOLS_PROMPT };
        }
        response = await callAiNonStream(config, msgsCopy);
      } else {
        throw err;
      }
    }
    console.log(`[AI] round ${round}: model responded in ${Date.now() - t0}ms, toolCalls=${response.toolCalls.length}`);

    // 第一轮：原生 FC 模式下模型既没生成 tool_calls、也没用 <tool> 标签，
    // 大概率是弱模型（如 qwen2.5-coder 量化版）不会用 OpenAI FC 协议。强制降级 prompt 模式重试一次，
    // 引导模型读 TOOLS_PROMPT 后输出 <tool>...</tool>，避免它凭训练数据编造笔记内容。
    if (round === 0 && supportsTools && response.toolCalls.length === 0 && response.content && !response.content.includes('<tool>')) {
      console.log(`[AI] round 0: native FC returned 0 tool calls, forcing prompt-mode retry`);
      supportsTools = false;
      const sysIdx = msgsCopy.findIndex(m => m.role === 'system');
      if (sysIdx >= 0 && typeof msgsCopy[sysIdx].content === 'string' && !(msgsCopy[sysIdx].content as string).includes('可用工具')) {
        msgsCopy[sysIdx] = { ...msgsCopy[sysIdx], content: (msgsCopy[sysIdx].content as string) + '\n\n' + TOOLS_PROMPT };
      }
      response = await callAiNonStream(config, msgsCopy);
      console.log(`[AI] round 0: prompt-mode retry, toolCalls=${response.toolCalls.length}, hasToolTag=${response.content?.includes('<tool>')}`);
    }

    // 原生工具调用
    if (response.toolCalls.length > 0) {
      msgsCopy.push({ role: 'assistant', content: response.content || '' });
      for (const tc of response.toolCalls) {
        const t1 = Date.now();
        onToolCall?.({ name: tc.name, args: tc.args });
        const { result, noteIds } = await executeToolFn(tc.name, tc.args);
        console.log(`[AI] tool ${tc.name}(${JSON.stringify(tc.args)}) executed in ${Date.now() - t1}ms, results: ${result.length} chars`);
        allNoteIds.push(...noteIds);
        msgsCopy.push({ role: 'tool' as any, content: result, tool_call_id: tc.id } as any);
      }
      continue;
    }

    // 提示词降级模式：检测 <tool> 标签
    if (response.content && response.content.includes('<tool>')) {
      const toolRegex = /<tool>([\s\S]*?)<\/tool>/g;
      let match;
      const calls: { name: string; args: any }[] = [];
      while ((match = toolRegex.exec(response.content)) !== null) {
        try { calls.push(JSON.parse(match[1])); } catch {}
      }
      if (calls.length > 0) {
        msgsCopy.push({ role: 'assistant', content: response.content });
        for (const tc of calls) {
          onToolCall?.({ name: tc.name, args: tc.args });
          const { result, noteIds } = await executeToolFn(tc.name, tc.args);
          allNoteIds.push(...noteIds);
          msgsCopy.push({ role: 'user', content: `[工具 ${tc.name} 执行结果]:\n${result}` });
        }
        continue;
      }
    }

    // 无工具调用 → 最终回答，用流式输出
    const finalStream = await callAiStream(config, msgsCopy, 2048);
    return { stream: finalStream, noteIds: [...new Set(allNoteIds)] };
  }

  // 超过最大轮次，强制流式输出
  const finalStream = await callAiStream(config, msgsCopy, 2048);
  return { stream: finalStream, noteIds: [...new Set(allNoteIds)] };
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
 *
 * 策略: {categories} 占位符注入用户当前所有分类名 (新用户注册时 seed 4 个默认大类),
 * AI 必须从列表里选, 后端校验返回不在列表就 null (防 AI 编造). 之前是 prompt 写死 9 个细分类 +
 * processNoteWithAi 看到 AI 返回新分类就自动 insert → 分类列表无限膨胀.
 */
export async function autoClassify(userId: string, content: string): Promise<string | null> {
  const config = await getConfigForFeature(userId, 'auto_classify');
  if (!config) return null;

  const text = cleanContent(content);
  if (text.length < 5) return null;

  // 查用户当前所有分类名, 拼成"工作、学习、生活、其他"形式塞进 prompt; 0 分类直接跳过分类 (老用户没 seed)
  const cats = await db.select({ name: schema.categories.name }).from(schema.categories)
    .where(eq(schema.categories.userId, userId)).all();
  const catNames = cats.map(c => c.name);
  if (catNames.length === 0) return null;
  const catList = catNames.join('、');

  const prompt = await getPrompt(userId, 'auto_classify');

  try {
    const result = await callAi(config, '你是一个分类助手，只返回分类名称。',
      prompt.replace('{categories}', catList).replace('{content}', text));
    const picked = result.trim().replace(/["""]/g, '');
    // 校验: AI 返回值必须在当前分类列表里, 否则 null (防 AI 编造新分类污染 categories 表)
    if (!picked || !catNames.includes(picked)) return null;
    return picked;
  } catch (err) {
    console.error('Auto-classify failed:', err);
    return null;
  }
}

/**
 * Generate a one-line summary for a note.
 *
 * 升级为一等公民 feature (加入 AI_FEATURES) — 独立绑定 AI 配置, 用 getPrompt 取用户自定义,
 * 不再硬编码 prompt / 不再复用 auto_tag 配置.
 */
export async function autoSummary(userId: string, content: string): Promise<string | null> {
  const config = await getConfigForFeature(userId, 'auto_summary');
  if (!config) return null;

  const prompt = await getPrompt(userId, 'auto_summary');
  const text = cleanContent(content);
  if (text.length < 20) return null;

  try {
    const result = await callAi(config, '你是一个摘要助手，只返回摘要文本。', prompt.replace('{content}', text));
    return result.trim().slice(0, 50) || null;
  } catch (err) {
    console.error('Auto-summary failed:', err);
    return null;
  }
}

/**
 * 精简笔记内容 (float「AI整理」后台执行). 独立 feature, 用 getPrompt 取用户自定义精简提示词.
 * 返回精简后文本; 失败/太短返回 null (调用方保留原文兜底).
 */
export async function autoSimplify(userId: string, content: string): Promise<string | null> {
  const config = await getConfigForFeature(userId, 'simplify');
  if (!config) return null;

  const prompt = await getPrompt(userId, 'simplify');
  // 保留原文换行/段落 (精简后回填笔记要保格式), 不走 cleanContent (它把 \s+ 压成单空格吃掉换行)
  const text = content.replace(/<[^>]*>/g, '').trim();
  if (text.length < 5) return null;

  try {
    const result = await callAi(config, '你是一个写作助手。', prompt.replace('{content}', text));
    return result.trim() || null;
  } catch (err) {
    console.error('Auto-simplify failed:', err);
    return null;
  }
}

/**
 * Generic AI call for polish/expand/write features.
 */
export async function aiProcess(userId: string, feature: AiFeature, content: string, customPrompt?: string, targetLang?: string): Promise<string> {
  const config = await getConfigForFeature(userId, feature);
  if (!config) throw new Error('未配置 AI 模型，请在设置中添加 AI 配置');

  const prompt = customPrompt || await getPrompt(userId, feature);
  // 保留原文段落/换行 (translate/polish/expand/write 要按原格式返回); 不走 cleanContent ——
  // 它的 \s+→单空格会把换行全压成空格, 导致译文/润色结果堆成一整段没换行
  const text = content.replace(/<[^>]*>/g, '').trim();

  // translate 的 prompt 带 {targetLang} 占位, 由调用方传入目标语种 (前端划词按中文占比自动判语向 /
  // 翻译窗口内二次选语言). 对不含占位符的 polish/expand/write 是无害 no-op.
  const filled = prompt
    .replace(/\{targetLang\}/g, targetLang || '英语')
    .replace('{content}', text);

  const result = await callAi(config, '你是一个写作助手。', filled);
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

/**
 * 语音转文字(Whisper API)
 */
export async function transcribeAudio(userId: string, audioBuffer: Buffer, mimeType: string): Promise<string> {
  const config = await getConfigForFeature(userId, 'auto_tag');
  if (!config || !config.apiKey) throw new Error('未配置 AI');

  let baseUrl = config.baseUrl.replace(/\/+$/, '');
  // OpenAI 兼容:自动拼 /v1
  if (!baseUrl.includes('/v1')) baseUrl += '/v1';

  const formData = new FormData();
  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'wav';
  // Node Buffer 直接给 Blob 在严格 TS 下不接受(Buffer<ArrayBufferLike> 不匹配 BlobPart 要求的 ArrayBuffer)
  // 转 Uint8Array 是个零拷贝 view,类型完美匹配 BlobPart,运行时行为完全一致
  formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), `audio.${ext}`);
  formData.append('model', 'whisper-1');
  formData.append('language', 'zh');

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Whisper API error: ${res.status} ${err}`);
  }

  const data = await res.json() as { text: string };
  return data.text || '';
}
