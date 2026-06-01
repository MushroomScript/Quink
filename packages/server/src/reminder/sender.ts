import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import type { AdapterFn, ReminderPayload } from './types.js';
import { browserAdapter } from './adapters/browser.js';
import { emailAdapter } from './adapters/email.js';
import { barkAdapter } from './adapters/bark.js';
import { wecomBotAdapter } from './adapters/wecom-bot.js';
import { dingtalkBotAdapter } from './adapters/dingtalk-bot.js';
import { feishuBotAdapter } from './adapters/feishu-bot.js';
import { telegramAdapter } from './adapters/telegram.js';
import { webhookAdapter } from './adapters/webhook.js';

const adapters: Record<string, AdapterFn> = {
  browser: browserAdapter,
  email: emailAdapter,
  bark: barkAdapter,
  wecom_bot: wecomBotAdapter,
  dingtalk_bot: dingtalkBotAdapter,
  feishu_bot: feishuBotAdapter,
  telegram: telegramAdapter,
  webhook: webhookAdapter,
};

export function getAdapter(type: string): AdapterFn | undefined {
  return adapters[type];
}

// 发到该用户的所有 enabled channels, 并发执行 + 单点失败不阻塞其他
export async function dispatchToAllChannels(userId: string, payload: ReminderPayload): Promise<void> {
  const channels = await db.select().from(schema.reminderChannels)
    .where(and(eq(schema.reminderChannels.userId, userId), eq(schema.reminderChannels.enabled, true)))
    .all();

  if (channels.length === 0) {
    console.log(`[reminder/sender] user ${userId} 无 enabled channel, 跳过 noteId=${payload.noteId}`);
    return;
  }

  await Promise.all(channels.map(async (ch) => {
    const fn = adapters[ch.type];
    if (!fn) {
      console.error(`[reminder/sender] 未知 channel type: ${ch.type}`);
      return;
    }
    try {
      await fn({ userId, config: ch.config || {}, payload });
      console.log(`[reminder/sender] ${ch.type}(${ch.name}) 发送成功 noteId=${payload.noteId}`);
    } catch (e) {
      console.error(`[reminder/sender] ${ch.type}(${ch.name}) 发送失败 noteId=${payload.noteId}:`, e);
    }
  }));
}

// 单点触发: Settings 页"测试发送"按钮用. 失败抛出, 前端拿到错误信息
export async function dispatchToSingleChannel(channelId: string, payload: ReminderPayload): Promise<void> {
  const ch = await db.select().from(schema.reminderChannels)
    .where(eq(schema.reminderChannels.id, channelId)).get();
  if (!ch) throw new Error('channel 不存在');
  const fn = adapters[ch.type];
  if (!fn) throw new Error(`未知 channel type: ${ch.type}`);
  await fn({ userId: ch.userId, config: ch.config || {}, payload });
}
