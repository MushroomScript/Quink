import crypto from 'node:crypto';
import type { AdapterFn } from '../types.js';

// 钉钉群机器人: POST webhook, 可选 secret 加签 (HMAC SHA256 + base64 + urlencode)
// config: { webhook, secret? } -- webhook 是完整 https://oapi.dingtalk.com/robot/send?access_token=xxx
// 文档: https://open.dingtalk.com/document/orgapp/custom-robot-access
// 若机器人安全设置选了"自定义关键词", webhook 无需 secret 但 content 必须含关键词 (由用户在 title/body 自带)
export const dingtalkBotAdapter: AdapterFn = async (ctx) => {
  let webhook = ctx.config.webhook as string | undefined;
  const secret = ctx.config.secret as string | undefined;
  if (!webhook) throw new Error('dingtalk_bot config 缺字段: 需要 webhook');

  if (secret) {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = encodeURIComponent(
      crypto.createHmac('sha256', secret).update(stringToSign).digest('base64')
    );
    webhook += `${webhook.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`;
  }

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
    throw new Error(`dingtalk_bot push 失败: ${res.status} errcode=${json.errcode} errmsg=${json.errmsg}`);
  }
};
