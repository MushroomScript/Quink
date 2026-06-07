// 操作审计日志 helper (蘑菇 2026-06-07 拍板)
// 后端所有"写" endpoint 关键位置调 logAudit(c, action, targetType, targetId, meta?)
// 文本字段为主, 占空间不大 (单条 ~200 字节 × 10 万操作 ~20MB)
//
// action 命名约定: '<domain>.<verb>' 全小写下划线分隔
//   auth: auth.login / auth.logout / auth.register / auth.password_change
//   note: note.create / note.update / note.delete / note.duplicate / note.restore / note.permanent_delete
//   note 权限: note.edit_request / note.edit_approve / note.edit_reject / note.edit_grant_revoke
//   note 互动: note.reaction / note.comment_create / note.comment_update / note.comment_delete
//   group: group.create / group.update / group.dissolve / group.member_add / group.member_kick / group.member_role
//   group: group.note_pin / group.note_unpin / group.announcement
//   file: file.upload / file.delete / file.rename
//   ai: ai.config_create / ai.config_update / ai.config_delete / ai.chat
//   notification (PR #10): notification.read / notification.read_all / notification.delete / notification.clear
//   admin: admin.cleanup_trash (cron 触发的) 等
//
// 失败 swallow (不阻塞主流程), console.error 留痕

import type { Context } from 'hono';
import { db, schema } from '../db/index.js';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';

export async function logAudit(
  c: Context,
  action: string,
  targetType?: string | null,
  targetId?: string | null,
  meta?: Record<string, any>,
): Promise<void> {
  try {
    const userId = c.get('userId') || 'anonymous';
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim()
      || c.req.header('x-real-ip')
      || null;
    await db.insert(schema.auditLogs).values({
      id: nanoid(12),
      userId,
      action,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      meta: meta ?? null,
      ip,
      createdAt: dayjs().toISOString(),
    });
  } catch (e) {
    console.error('[audit] failed:', action, e);
  }
}

// 非 Hono context 场景用 (如 scheduler / cron / 系统操作), 必须显式传 userId
export async function logAuditSystem(
  userId: string,
  action: string,
  targetType?: string | null,
  targetId?: string | null,
  meta?: Record<string, any>,
): Promise<void> {
  try {
    await db.insert(schema.auditLogs).values({
      id: nanoid(12),
      userId,
      action,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      meta: meta ?? null,
      ip: null,
      createdAt: dayjs().toISOString(),
    });
  } catch (e) {
    console.error('[audit] system failed:', action, e);
  }
}
