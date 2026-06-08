import { eq, and, sql } from 'drizzle-orm';
import dayjs from 'dayjs';
import { db, schema } from './db/index.js';

// PR #12 群组回收站 7 天后强清 (个人回收站默认 30 天可改)
export const GROUP_TRASH_RETENTION_DAYS = 7;

// 永久删一条笔记 + cascade 清所有外键关联表 (notes 被 9 张子表 FK 引用, pragma foreign_keys=ON 不清子表会阻 delete).
// 给个人 trash 永久删 + 群回收站永久删 + 7 天 cron 自清共用 (个人 trash 旧 inline cleanup 仅清 notes 是 FK 漏网之鱼, 未来一并迁这里)
export function purgeNote(noteId: string) {
  db.transaction((tx) => {
    tx.delete(schema.groupNotePins).where(eq(schema.groupNotePins.noteId, noteId)).run();
    tx.delete(schema.noteShares).where(eq(schema.noteShares.noteId, noteId)).run();
    tx.delete(schema.noteEditGrants).where(eq(schema.noteEditGrants.noteId, noteId)).run();
    tx.delete(schema.noteEditRequests).where(eq(schema.noteEditRequests.noteId, noteId)).run();
    tx.delete(schema.noteEditHistory).where(eq(schema.noteEditHistory.noteId, noteId)).run();
    tx.delete(schema.noteReactions).where(eq(schema.noteReactions.noteId, noteId)).run();
    tx.delete(schema.noteComments).where(eq(schema.noteComments.noteId, noteId)).run();
    tx.delete(schema.notePersonalReminders).where(eq(schema.notePersonalReminders.noteId, noteId)).run();
    tx.delete(schema.noteGroupReminders).where(eq(schema.noteGroupReminders.noteId, noteId)).run();
    tx.delete(schema.notes).where(eq(schema.notes.id, noteId)).run();
  });
}

// 回收站自动清理: 给定用户 + 保留天数, 删 deletedAt 早于 cutoff 的笔记 (better-sqlite3 同步 API, 无需 await)
// 走 purgeNote 完整 cascade (修原版只 delete notes 不清 noteEditGrants / notePersonalReminders 等子表,
// pragma foreign_keys=ON 下若 private 笔记有提醒会 FK 阻 delete)
export function cleanTrashForUser(userId: string, days: number) {
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = dayjs().subtract(days, 'day').toISOString();
  const expired = db.select({ id: schema.notes.id }).from(schema.notes).where(and(
    eq(schema.notes.userId, userId),
    sql`${schema.notes.deletedAt} IS NOT NULL`,
    sql`${schema.notes.deletedAt} < ${cutoff}`,
  )).all();
  for (const e of expired) purgeNote(e.id);
}

// PR #12 + PR #13 fix 群组回收站 7 天清扫: 扫所有"共享笔记被删超过 7 天" (走 note_shares JOIN, 不依赖 deleted_in_group_id 单字段)
// 跟个人 trash 30 天 cleanup 重叠时, 7 天先命中 → 共享笔记实际寿命被群 cleanup 截到 7 天 (蘑菇规则)
export function cleanGroupTrash() {
  try {
    const cutoff = dayjs().subtract(GROUP_TRASH_RETENTION_DAYS, 'day').toISOString();
    const expired = db.all(sql`
      SELECT DISTINCT n.id FROM notes n
      INNER JOIN note_shares ns ON ns.note_id = n.id
      WHERE n.deleted_at IS NOT NULL AND n.deleted_at < ${cutoff}
    `) as Array<{ id: string }>;
    for (const e of expired) purgeNote(e.id);
    if (expired.length > 0) console.log(`[cleanGroupTrash] purged ${expired.length} notes older than ${GROUP_TRASH_RETENTION_DAYS}d`);
  } catch (e) { console.error('[cleanGroupTrash]', e); }
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

// PR #12 audit_logs 内容快照清: 仅清 meta.snapshot 字段 (大头 content 上限 1MB), 保留行让审计追溯链完整.
// 90 天足够事后调查 + 单用户 user.update * (千次/天) 单条 1MB → 长期累积 audit 表能爆数 GB.
// SQLite json_remove 原生支持, drizzle 端 mode 'json' 仍能反序列化清字段后的 meta
const AUDIT_SNAPSHOT_RETENTION_DAYS = 90;
export function cleanOldAuditSnapshots() {
  try {
    const cutoff = dayjs().subtract(AUDIT_SNAPSHOT_RETENTION_DAYS, 'day').toISOString();
    const result = db.run(sql`
      UPDATE audit_logs
      SET meta = json_remove(meta, '$.snapshot')
      WHERE created_at < ${cutoff}
        AND json_extract(meta, '$.snapshot') IS NOT NULL
    `);
    if (result.changes > 0) console.log(`[cleanOldAuditSnapshots] purged snapshot from ${result.changes} audit logs older than ${AUDIT_SNAPSHOT_RETENTION_DAYS}d`);
  } catch (e) { console.error('[cleanOldAuditSnapshots]', e); }
}
