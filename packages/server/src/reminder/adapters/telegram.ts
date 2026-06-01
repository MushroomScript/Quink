import type { AdapterFn } from '../types.js';

// Telegram Bot: POST api.telegram.org/bot<token>/sendMessage
// config: { bot_token, chat_id }
// chat_id 可以是用户 ID (数字) 或群组 ID (-100xxxxxx) 或 @channelname
export const telegramAdapter: AdapterFn = async (ctx) => {
  const c = ctx.config;
  if (!c.bot_token || !c.chat_id) {
    throw new Error('telegram config 缺字段: 需要 bot_token + chat_id');
  }
  const url = `https://api.telegram.org/bot${c.bot_token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: c.chat_id,
      text: `*${ctx.payload.title}*\n${ctx.payload.body}`,
      parse_mode: 'Markdown',
    }),
  });
  const json = await res.json().catch(() => ({} as any));
  if (!res.ok || !json.ok) {
    throw new Error(`telegram push 失败: ${res.status} ${json.description || ''}`);
  }
};
