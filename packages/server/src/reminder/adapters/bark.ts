import type { AdapterFn } from '../types.js';

// Bark (iOS 个人推送): HTTP GET 一个 URL 就推
// config: { url } 完整 push URL (https://api.day.app/<KEY>) 或 { server, key }
// title/body 走 query string, encodeURIComponent 防特殊字符
export const barkAdapter: AdapterFn = async (ctx) => {
  const c = ctx.config;
  let base = c.url as string | undefined;
  if (!base && c.server && c.key) {
    base = `${String(c.server).replace(/\/$/, '')}/${c.key}`;
  }
  if (!base) throw new Error('bark config 缺字段: 需要 url 或 server+key');

  const title = encodeURIComponent(ctx.payload.title);
  const body = encodeURIComponent(ctx.payload.body || ' '); // 空 body 会被 Bark 当 404
  const url = `${base.replace(/\/$/, '')}/${title}/${body}`;

  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bark push 失败: ${res.status} ${text}`);
  }
};
