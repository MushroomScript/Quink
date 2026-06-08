// PR #10 通知中心 helper
// 集中所有"用户该被告知"的事件 (申请编辑权 / 另存为 / 提醒到点 / 群组变更 / 评论等),
// 替代以前散落各处的 toast/SSE 直推. 调用方传"收件人 userId" + 分类 + 类型 + 标题/详情/跳转 payload,
// helper 负责写 notifications 表 + SSE publish('notification-new') 让收件人前端徽章+列表实时更新.
//
// 失败 swallow (不阻塞主流程), console.error 留痕. 通知失败不该让"删笔记"等核心写操作失败.
//
// category 枚举对应 UI 3 tab: content (笔记相关) / reminder (提醒到点) / group (群组事件)
// type 字符串非枚举 (后续加新 type 不用 ALTER 表), 命名约定:
//   content: 'edit-request' / 'edit-request-approved' / 'edit-request-rejected' / 'duplicated' /
//            'note-deleted-by-admin' / 'fork-by-other' / 'comment-added' / 'comment-replied'
//   reminder: 'reminder-due' / 'group-reminder-due'
//   group:    'group-join-request' / 'group-joined' / 'group-removed' / 'group-promoted' /
//             'group-demoted' / 'group-dissolved'

import { db, schema } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import dayjs from 'dayjs';
import { publish } from '../reminder/bus.js';
import type { NotificationCategory } from '../db/schema.js';

export async function createNotification(
  userId: string,
  category: NotificationCategory,
  type: string,
  title: string,
  body?: string | null,
  payload?: Record<string, any> | null,
): Promise<void> {
  try {
    const id = nanoid(12);
    const createdAt = dayjs().toISOString();
    const row = {
      id,
      userId,
      category,
      type,
      title,
      body: body ?? null,
      payload: payload ?? {},
      readAt: null,
      createdAt,
    };
    await db.insert(schema.notifications).values(row);
    // SSE 推送收件人 (含他多设备). payload 含核心字段让前端就地新增列表头 + 徽章 +1, 不必拉接口
    publish(userId, 'notification-new', {
      id,
      category,
      type,
      title,
      body: row.body,
      payload: row.payload,
      createdAt,
    });
  } catch (e) {
    console.error('[notifications] createNotification failed:', { userId, category, type, title }, e);
  }
}

// 申请类通知 (edit-request / group-join-request) 被某 admin/作者从其他入口同意/拒绝后,
// 标已读所有相关收件人的对应通知 (作者+所有群 admin 都收到的同一条申请通知), 不让通知中心仍显红点.
// SQLite json_extract 按 payload.requestId 精确匹配. 同步给受影响 user 派 notification-changed SSE 让通知页/徽章实时更新.
export async function markRequestNotificationsRead(types: string[], requestId: string): Promise<void> {
  try {
    const affected = db.all(sql`
      SELECT id, user_id FROM notifications
      WHERE type IN (${sql.join(types.map(t => sql`${t}`), sql`, `)})
        AND json_extract(payload, '$.requestId') = ${requestId}
        AND read_at IS NULL
    `) as Array<{ id: string; user_id: string }>;
    if (affected.length === 0) return;
    const now = dayjs().toISOString();
    db.run(sql`
      UPDATE notifications SET read_at = ${now}
      WHERE id IN (${sql.join(affected.map(a => sql`${a.id}`), sql`, `)})
    `);
    for (const a of affected) {
      publish(a.user_id, 'notification-changed', { scope: 'read', id: a.id });
    }
  } catch (e) {
    console.error('[notifications] markRequestNotificationsRead failed:', { types, requestId }, e);
  }
}
