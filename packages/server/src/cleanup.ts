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
