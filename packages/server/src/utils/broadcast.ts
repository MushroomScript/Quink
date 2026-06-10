// 跨 endpoint 共用的 SSE 广播 helper. 历史定义在 routes/notes.ts 内私有, 后抽出复用.
// 当前包: broadcastNoteShared (shared 笔记内容/分享变化时通知群成员刷 feed).
// 后续要加 broadcastNoteSocial / broadcastGroupChanged 等也归这里, 跟 reminder/bus.ts 的 publish 区分:
// - publish: 单点推送给某 userId 所有 SSE 连接
// - broadcast*: 拉群成员 → 多点 publish, 含节流 + dedup 逻辑

import { db, schema } from '../db/index.js';
import { and, eq, inArray } from 'drizzle-orm';
import { publish } from '../reminder/bus.js';

// SSE 节流: 同一 (actorUserId, groupId) 在 1s 窗口内最多推一次, 防 PATCH 连发刷屏
const SSE_THROTTLE_WINDOW_MS = 1000;
const broadcastShareThrottle = new Map<string, number>();

setInterval(() => {
  const cutoff = Date.now() - SSE_THROTTLE_WINDOW_MS * 5;
  for (const [k, ts] of broadcastShareThrottle) {
    if (ts < cutoff) broadcastShareThrottle.delete(k);
  }
}, 30 * 1000);

// 给指定群列表的所有 active 成员 (除 exceptUserId) publish 'group-notes-changed'
// 一个用户在多个目标群里也只一条事件 (按 userId+groupId dedup)
export async function broadcastNoteShared(groupIds: string[], exceptUserId: string, originClientId?: string) {
  if (groupIds.length === 0) return;
  const now = Date.now();
  const allowedGroupIds = groupIds.filter(gid => {
    const key = exceptUserId + '|' + gid;
    const last = broadcastShareThrottle.get(key) || 0;
    if (now - last < SSE_THROTTLE_WINDOW_MS) return false;
    broadcastShareThrottle.set(key, now);
    return true;
  });
  if (allowedGroupIds.length === 0) return;

  const members = await db.select({ userId: schema.groupMembers.userId, groupId: schema.groupMembers.groupId })
    .from(schema.groupMembers)
    .where(and(
      inArray(schema.groupMembers.groupId, allowedGroupIds),
      eq(schema.groupMembers.status, 'active'),
    )).all();
  const seen = new Set<string>();
  for (const m of members) {
    if (m.userId === exceptUserId) continue;
    const key = m.userId + '|' + m.groupId;
    if (seen.has(key)) continue;
    seen.add(key);
    publish(m.userId, 'group-notes-changed', { groupId: m.groupId }, originClientId);
  }
}
