import crypto from 'node:crypto';
import type { AdapterFn } from '../types.js';

// 飞书群机器人: POST webhook, 可选 secret 加签 (timestamp + "\n" + secret -> HMAC SHA256 -> base64)
// config: { webhook, secret? }
// 文档: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
// 注意飞书签名 algo 跟钉钉不同: 钉钉是 hmac(secret, timestamp+secret), 飞书是 hmac(timestamp+"\n"+secret, "")
export const feishuBotAdapter: AdapterFn = async (ctx) => {
  const webhook = ctx.config.webhook as string | undefined;
  const secret = ctx.config.secret as string | undefined;
  if (!webhook) throw new Error('feishu_bot config 缺字段: 需要 webhook');

  const body: Record<string, any> = {
    msg_type: 'text',
    content: { text: `${ctx.payload.title}\n${ctx.payload.body}` },
  };

  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto.createHmac('sha256', stringToSign).update('').digest('base64');
    body.timestamp = String(timestamp);
    body.sign = sign;
  }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({} as any));
  if (!res.ok || (json.code !== 0 && json.StatusCode !== 0)) {
    throw new Error(`feishu_bot push 失败: ${res.status} code=${json.code ?? json.StatusCode} msg=${json.msg ?? json.StatusMessage}`);
  }
};
