import type { AdapterFn } from '../types.js';
import { publish, hasSubscribers } from '../bus.js';
import { db, schema } from '../../db/index.js';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';

// 浏览器/Electron 通知: 通过 SSE 推给前端, 前端调 Notification API
// 不在线时挂 reminder_pending 表, 用户 SSE ready 时补送 (sse 路由内 flushPendingReminders).
// 不再静默丢弃 — 蘑菇 Q1: 离线提醒会永久丢
export const browserAdapter: AdapterFn = async (ctx) => {
  const payload = {
    noteId: ctx.payload.noteId,
    title: ctx.payload.title,
    body: ctx.payload.body,
    remindAt: ctx.payload.remindAt,
  };
  if (hasSubscribers(ctx.userId)) {
    publish(ctx.userId, 'reminder', payload);
    return;
  }
  console.log(`[reminder/browser] user ${ctx.userId} 无 SSE 连接, 挂 pending 等上线补送`);
  await db.insert(schema.reminderPending).values({
    id: nanoid(12),
    userId: ctx.userId,
    payload: JSON.stringify(payload),
    createdAt: dayjs().toISOString(),
  });
};
