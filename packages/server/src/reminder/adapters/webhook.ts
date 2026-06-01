import type { AdapterFn } from '../types.js';

// 通用 webhook: POST 自定义 URL, body 是 JSON {title, body, remindAt, noteId}
// config: { url, method?, headers?(JSON 对象) }
// 后续可考虑加 body_template 但当前 KISS, JSON 结构固定
export const webhookAdapter: AdapterFn = async (ctx) => {
  const c = ctx.config;
  if (!c.url) throw new Error('webhook config 缺字段: 需要 url');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (c.headers && typeof c.headers === 'object') {
    for (const [k, v] of Object.entries(c.headers as Record<string, any>)) {
      headers[k] = String(v);
    }
  }

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
    const text = await res.text().catch(() => '');
    throw new Error(`webhook push 失败: ${res.status} ${text.slice(0, 200)}`);
  }
};
