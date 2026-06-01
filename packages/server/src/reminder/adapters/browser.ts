import type { AdapterFn } from '../types.js';
import { publish, hasSubscribers } from '../bus.js';

// 浏览器/Electron 通知: 通过 SSE 推给前端, 前端调 Notification API
// 没活跃 SSE 连接时静默丢弃(不抛错, 让其他 channel 继续走)
export const browserAdapter: AdapterFn = async (ctx) => {
  if (!hasSubscribers(ctx.userId)) {
    console.log(`[reminder/browser] user ${ctx.userId} 无 SSE 连接, 跳过`);
    return;
  }
  publish(ctx.userId, 'reminder', {
    noteId: ctx.payload.noteId,
    title: ctx.payload.title,
    body: ctx.payload.body,
    remindAt: ctx.payload.remindAt,
  });
};
