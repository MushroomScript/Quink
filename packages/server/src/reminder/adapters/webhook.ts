import type { AdapterFn } from '../types.js';
import { validateOutboundUrl, sanitizeFetchError } from '../../utils/urlGuard.js';

// 通用 webhook: POST 自定义 URL, body 是 JSON {title, body, remindAt, noteId}
// config: { url, method?, headers?(JSON 对象) }
// 校验 URL 防 SSRF + header key 黑名单防 Host/Connection 等 hop-by-hop 头注入
const BLOCKED_HEADER_KEYS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'cookie', 'authorization-source', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-host',
]);

export const webhookAdapter: AdapterFn = async (ctx) => {
  const c = ctx.config;
  if (!c.url) throw new Error('webhook config 缺字段: 需要 url');

  // SSRF 校验
  const guard = await validateOutboundUrl(c.url as string);
  if (!guard.ok) throw new Error(`webhook URL 不安全: ${guard.reason}`);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (c.headers && typeof c.headers === 'object') {
    for (const [k, v] of Object.entries(c.headers as Record<string, any>)) {
      // 拒绝 hop-by-hop / 元数据头 (防绕过反代 IP 限制 / 注入 Host 头)
      if (BLOCKED_HEADER_KEYS.has(k.toLowerCase())) continue;
      headers[k] = String(v);
    }
  }

  try {
    const res = await fetch(c.url, {
      method: (c.method as string) || 'POST',
      headers,
      body: JSON.stringify({
        noteId: ctx.payload.noteId,
        title: ctx.payload.title,
        body: ctx.payload.body,
        remindAt: ctx.payload.remindAt,
      }),
    });
    if (!res.ok) {
      // 错误信息脱敏: 不返回上游 body 防泄漏内网信息
      throw new Error(`webhook push 失败: HTTP ${res.status}`);
    }
  } catch (err: any) {
    if (err.message?.startsWith('webhook')) throw err;
    throw new Error(`webhook push 失败: ${sanitizeFetchError(err)}`);
  }
};
