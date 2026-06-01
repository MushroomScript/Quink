import type { AdapterFn } from '../types.js';

// 企业微信群机器人: POST webhook 即可, 无签名
// config: { webhook } -- 完整 webhook URL
// 文档: https://developer.work.weixin.qq.com/document/path/91770
export const wecomBotAdapter: AdapterFn = async (ctx) => {
  const webhook = ctx.config.webhook as string | undefined;
  if (!webhook) throw new Error('wecom_bot config 缺字段: 需要 webhook');

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: `${ctx.payload.title}\n${ctx.payload.body}` },
    }),
  });
  const json = await res.json().catch(() => ({} as any));
  if (!res.ok || json.errcode !== 0) {
    throw new Error(`wecom_bot push 失败: ${res.status} errcode=${json.errcode} errmsg=${json.errmsg}`);
  }
};
