import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { DEFAULT_PROMPTS, type AiFeature } from './prompts.js';
import { TOOLS_PROMPT, TOOL_DEFINITIONS } from './tools.js';

// 裸 JSON 兜底识别时用来判断"这个 name 是不是真的工具", 防止把用户内容里的普通 JSON 当成调用
const KNOWN_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(t => t.function.name));

// AI 上游请求超时 (REVIEW-TODO Sprint 3 P10).
// 原来所有 AI fetch 都没有超时: 上游卡住 (本地 ollama 显存不够挂起 / 云端网络黑洞) 就永远挂着,
// 后台自动打标签那条链路还会一直占着并发名额, 表现是"笔记一直转圈不出标签"且没有任何报错.
// 90s 给本地大模型留足余量 (14b 量化模型首 token 就可能十几秒), 又不至于真卡死时无限等.
const AI_TIMEOUT_MS = 90_000;
// 把"调用方传进来的取消信号"跟"超时信号"合并: 任一触发就中断.
// AbortSignal.any 是 Node 20+ API, 项目要求 Node 20+ (README 部署章节), 可以直接用.
function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(AI_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

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

// maxTokens 默认 1024 够 tag/classify/summary 短输出用. polish/expand/write/simplify/translate/chat
// 这类"输出可能上千 tokens" 的 feature 调用时传 8192, 否则本地 ollama / 云端都会在 1024 处硬截.
async function callAi(config: AiConfig, systemPrompt: string, userMessage: string, maxTokens = 1024): Promise<string> {
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
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: withTimeout(),
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
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: withTimeout(),
    });

    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }
}

// 长输出 feature (润色 / 扩充 / 写文 / 整理 / 翻译 / 对话) 用: 覆盖 callAi 默认 1024 上限
const LONG_OUTPUT_MAX_TOKENS = 8192;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string }; source?: { type: string; media_type: string; data: string } }>;
  // OpenAI function calling 协议要求成对出现: assistant 发起调用时带 tool_calls,
  // role:'tool' 的结果消息必须带 tool_call_id 指回去. 缺任一边 OpenAI 直接 400.
  // (原来这两个字段没进类型, 工具循环里靠 `as any` 硬塞, 结果发请求时被 map 掉了 —— REVIEW-TODO B9)
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export async function callAiStream(config: AiConfig, messages: ChatMessage[], maxTokens = 2048, signal?: AbortSignal): Promise<ReadableStream<string>> {
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
      signal: withTimeout(signal),
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
      signal: withTimeout(signal),
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

export { getConfigForFeature, getPrompt, buildEndpoint };

// ── Function Calling 工具调用循环 ──

interface ToolCallResult {
  toolCalls: { name: string; args: any; id: string }[];
}

async function callAiNonStream(config: AiConfig, messages: ChatMessage[], tools?: any[], signal?: AbortSignal): Promise<{ content: string | null; toolCalls: { name: string; args: any; id: string }[] }> {
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
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: withTimeout(signal) });
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
      // 必须透传 tool_calls / tool_call_id (REVIEW-TODO B9): 工具循环第二轮发的消息里带着
      // role:'tool' 的执行结果, 只挑 role+content 的话这两个字段就丢了, OpenAI 会以
      // "messages with role 'tool' must be a response to a preceding message with 'tool_calls'" 400
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
      max_tokens: 2048, temperature: 0.3,
    };
    if (tools?.length) body.tools = tools;
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: withTimeout(signal) });
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

// 从模型回复里抠出"裸 JSON 形式"的工具调用.
// 背景 (蘑菇 2026-07-27 报): 提示词降级模式要求模型输出 `<tool>{...}</tool>`, 但 qwen2.5-coder
// 这类代码模型习惯直接吐 `{"name":"create_note","args":{...}}` 不套标签 —— 工具名跟参数其实全对,
// 只是标签没加, 结果被当成普通聊天文本原样打给用户看. 只认标签太苛刻, 这里做兜底.
//
// 防误伤: 必须同时满足 name 在已知工具名单内 + args 是对象, 才认作工具调用. 用户笔记正文里
// 恰好出现一段"name 正好等于某工具名且带 args 对象"的 JSON 才会误判, 概率可忽略.
// 括号配对手写而不用正则: 参数值里可能带 { } (如 content 是一段 JSON 文本), 正则配不平.
function extractBareToolCalls(content: string, knownNames: Set<string>): { name: string; args: any }[] {
  const calls: { name: string; args: any }[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < content.length; j++) {
      const ch = content[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { end = j; break; }
    }
    if (end < 0) break;              // 后面没有配平的 }, 不用再找了
    try {
      const obj = JSON.parse(content.slice(i, end + 1));
      // 参数字段两种写法都认: TOOLS_PROMPT 教的是 args, 但模型 (实测 qwen2.5-coder) 更倾向输出
      // OpenAI 原生的 arguments. 只认一种的话另一种就漏了
      const rawArgs = obj?.args ?? obj?.arguments;
      if (obj && typeof obj.name === 'string' && knownNames.has(obj.name)
          && rawArgs && typeof rawArgs === 'object') {
        calls.push({ name: obj.name, args: rawArgs });
        i = end;                     // 跳过整个已识别的对象, 避免嵌套重复命中
      }
    } catch { /* 不是合法 JSON, 继续往后找 */ }
  }
  return calls;
}

// 降级到提示词模式前, 把 FC 协议残留从消息历史里摘掉 (REVIEW-TODO B9).
// 降级后不再传 tools, 但 msgsCopy 里可能已经攒了前几轮的 role:'tool' 结果 + 带 tool_calls 的 assistant,
// 这些在"没有 tools 的请求"里是非法的, 会让降级重试本身又 400 —— 等于降级白做.
// 代价: 已执行的工具结果从上下文里丢了, 模型可能重新调一次. 降级路径优先保证"能跑通".
function stripFcArtifacts(msgs: ChatMessage[]): ChatMessage[] {
  return msgs
    .filter(m => m.role !== 'tool')
    .map(m => (m.tool_calls ? { ...m, tool_calls: undefined } : m));
}

// 从模型回复文本里解析工具调用: 先认 <tool> 标签 (TOOLS_PROMPT 教的格式), 再兜底认裸 JSON.
// 不支持 OpenAI FC 协议的模型 (实测 ollama 的 qwen2.5-coder / qwen2.5) 即使传了 tools 参数,
// 也不会返回 tool_calls 字段, 而是把调用意图写在 content 里 —— 所以原生调用的 content 也要过一遍.
function parseToolCallsFromText(content: string): { name: string; args: any }[] {
  const calls: { name: string; args: any }[] = [];
  const toolRegex = /<tool>([\s\S]*?)<\/tool>/g;
  let match;
  while ((match = toolRegex.exec(content)) !== null) {
    try {
      const o = JSON.parse(match[1]);
      const a = o?.args ?? o?.arguments;
      if (o && typeof o.name === 'string') calls.push({ name: o.name, args: a ?? {} });
    } catch { /* 标签里不是合法 JSON, 跳过 */ }
  }
  if (calls.length === 0) calls.push(...extractBareToolCalls(content, KNOWN_TOOL_NAMES));
  return calls;
}

export async function callAiWithToolLoop(
  config: AiConfig,
  messages: ChatMessage[],
  tools: any[],
  executeToolFn: (name: string, args: any) => Promise<{ result: string; noteIds: string[] }>,
  onToolCall?: (event: ToolCallEvent) => void,
  maxRounds = 5,
  signal?: AbortSignal,
): Promise<{ stream: ReadableStream<string>; noteIds: string[] }> {
  const allNoteIds: string[] = [];
  // let 而非 const: 降级到提示词模式时要整体换成 stripFcArtifacts 过滤后的副本
  let msgsCopy = [...messages];
  let supportsTools = true;

  for (let round = 0; round < maxRounds; round++) {
    let response: { content: string | null; toolCalls: { name: string; args: any; id: string }[] };
    const t0 = Date.now();

    try {
      response = await callAiNonStream(config, msgsCopy, supportsTools ? tools : undefined, signal);
    } catch (err: any) {
      if (err.message.includes('400') && supportsTools) {
        supportsTools = false;
        console.log(`[AI] round ${round}: FC not supported, falling back to prompt mode`);
        // 降级：把工具描述注入 system prompt
        const sysIdx = msgsCopy.findIndex(m => m.role === 'system');
        if (sysIdx >= 0 && typeof msgsCopy[sysIdx].content === 'string' && !(msgsCopy[sysIdx].content as string).includes('可用工具')) {
          msgsCopy[sysIdx] = { ...msgsCopy[sysIdx], content: msgsCopy[sysIdx].content + '\n\n' + TOOLS_PROMPT };
        }
        // 这里可能已经跑过几轮工具, msgsCopy 里带着 FC 协议消息, 不清掉降级重试自己会 400 (REVIEW-TODO B9)
        msgsCopy = stripFcArtifacts(msgsCopy);
        response = await callAiNonStream(config, msgsCopy, undefined, signal);
      } else {
        throw err;
      }
    }
    console.log(`[AI] round ${round}: model responded in ${Date.now() - t0}ms, toolCalls=${response.toolCalls.length}`);

    // 模型没走 FC 协议, 但可能已经把调用意图写在 content 里了 (裸 JSON / <tool> 标签).
    // 必须在下面"强制降级重试"之前先抠一次 —— 降级会把 response 整个覆盖掉, 而实测 ollama qwen 的
    // 行为是: 原生这轮的 content 里有正确的 {"name":...,"arguments":{...}}, 降级重试反而改口说
    // "已添加灵感xxx" 什么都不调. 先抠到就直接执行, 省一次重试也避免模型编造成功消息 (蘑菇 2026-07-27)
    if (response.toolCalls.length === 0 && response.content) {
      const earlyCalls = parseToolCallsFromText(response.content);
      if (earlyCalls.length > 0) {
        console.log(`[AI] round ${round}: 无 tool_calls 字段, 从回复文本识别到 ${earlyCalls.length} 个调用: ${earlyCalls.map(c => c.name).join(',')}`);
        msgsCopy.push({ role: 'assistant', content: response.content });
        for (const tc of earlyCalls) {
          onToolCall?.({ name: tc.name, args: tc.args });
          const { result, noteIds } = await executeToolFn(tc.name, tc.args);
          allNoteIds.push(...noteIds);
          msgsCopy.push({ role: 'user', content: `[工具 ${tc.name} 执行结果]:\n${result}` });
        }
        continue;
      }
    }

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
      response = await callAiNonStream(config, msgsCopy, undefined, signal);
      console.log(`[AI] round 0: prompt-mode retry, toolCalls=${response.toolCalls.length}, hasToolTag=${response.content?.includes('<tool>')}`);
    }

    // 原生工具调用
    if (response.toolCalls.length > 0) {
      // assistant 必须带 tool_calls, 否则下面 push 的 role:'tool' 消息在 OpenAI 眼里是"没有对应
      // 调用的孤儿结果", 同样 400 (REVIEW-TODO B9). Anthropic 分支不读这个字段, 带着无害
      msgsCopy.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });
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

    // 降级重试后再解析一次 (上面那次是降级前的 response, 这次是降级后的)
    if (response.content) {
      const calls = parseToolCallsFromText(response.content);
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
    const finalStream = await callAiStream(config, msgsCopy, 2048, signal);
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
    const result = await callAi(config, '你是一个写作助手。', prompt.replace('{content}', text), LONG_OUTPUT_MAX_TOKENS);
    return result.trim() || null;
  } catch (err) {
    console.error('Auto-simplify failed:', err);
    return null;
  }
}

// 原 aiProcess (非流式 polish/expand/write) 已在 2026-07-07 改造为 SSE 流式, 逻辑内联到 routes/ai-config.ts POST /process.
// 保留 callAiStream + getConfigForFeature + getPrompt export 给该 handler 用.

/**
 * AI chat with context (for RAG).
 */
export async function aiChat(userId: string, question: string, context: string): Promise<string> {
  const config = await getConfigForFeature(userId, 'chat');
  if (!config) throw new Error('未配置 AI 模型，请在设置中添加 AI 配置');

  const prompt = await getPrompt(userId, 'chat');
  const filledPrompt = prompt.replace('{context}', context).replace('{content}', question);

  const result = await callAi(config, filledPrompt, question, LONG_OUTPUT_MAX_TOKENS);
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
    // 转写要先把整段音频传上去再等结果, 比纯文本请求慢得多, 给 3 倍时间 (REVIEW-TODO P10)
    signal: AbortSignal.timeout(AI_TIMEOUT_MS * 3),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Whisper API error: ${res.status} ${err}`);
  }

  const data = await res.json() as { text: string };
  return data.text || '';
}
