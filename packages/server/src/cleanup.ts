import { eq, and, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { db, schema } from './db/index.js';

// 回收站自动清理: 给定用户 + 保留天数, 删 deletedAt 早于 cutoff 的笔记 (better-sqlite3 同步 API, 无需 await)
export function cleanTrashForUser(userId: string, days: number) {
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = dayjs().subtract(days, 'day').toISOString();
  db.delete(schema.notes).where(and(
    eq(schema.notes.userId, userId),
    sql`${schema.notes.deletedAt} IS NOT NULL`,
    sql`${schema.notes.deletedAt} < ${cutoff}`,
  )).run();
}

// 全用户跑一次: 启动 + 每 6h 定时 + (顺手) 保存设置触发都走这里
export function cleanAllTrash() {
  try {
    const users = db.select({ id: schema.users.id, preferences: schema.users.preferences }).from(schema.users).all();
    for (const u of users) {
      const raw = (u.preferences as any)?.trashRetentionDays;
      const days = typeof raw === 'number' && raw >= 0 ? raw : 30;
      cleanTrashForUser(u.id, days);
    }
  } catch (e) { console.error('[cleanAllTrash]', e); }
}

// PR #10 通知 30 天清: 仅清已读 (read_at IS NOT NULL) + created_at 早于 30 天前. 未读不清 (用户没看到).
// 硬编码 30 天不开 user.preferences (通知不是用户主动产生的数据, 不像 trash 用户在意保留期).
// 同 cleanAllTrash 6h 跑一次, 跑量级很小 (单用户通知不至于上千)
const NOTIFICATION_RETENTION_DAYS = 30;
export function cleanOldNotifications() {
  try {
    const cutoff = dayjs().subtract(NOTIFICATION_RETENTION_DAYS, 'day').toISOString();
    const result = db.delete(schema.notifications).where(and(
      sql`${schema.notifications.readAt} IS NOT NULL`,
      sql`${schema.notifications.createdAt} < ${cutoff}`,
    )).run();
    if (result.changes > 0) console.log(`[cleanOldNotifications] purged ${result.changes} read notifications older than ${NOTIFICATION_RETENTION_DAYS}d`);
  } catch (e) { console.error('[cleanOldNotifications]', e); }
}
