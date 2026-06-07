import { db, schema } from '../db/index.js';
import { eq, and, sql, isNotNull, inArray } from 'drizzle-orm';
import dayjs from 'dayjs';
// rrule 2.8.1 是 UMD/webpack 打包, Node ESM 走 cjs interop 时只能从 default 拿 RRule 类的值.
// 直接 named import 会抛 "does not provide an export named 'RRule'". 走 default 再解构.
// 类型走 import type {} from 'rrule' (TS 走 .d.ts 直接通, 跟运行时 cjs interop 解耦)
import rrulePkg from 'rrule';
import type { RRule as RRuleType } from 'rrule';
const { RRule } = rrulePkg;
import { dispatchToAllChannels } from './sender.js';
import { publish } from './bus.js';
import type { ReminderPayload } from './types.js';
import { createNotification } from '../utils/notifications.js';

const SCAN_INTERVAL_MS = 60_000; // 每分钟扫一次
let timer: NodeJS.Timeout | null = null;

// 从笔记 markdown 内容提取首行 + 截短作通知正文 (去掉图片 / 链接装饰让文字干净点)
function extractPreview(content: string, maxLen = 120): string {
  const cleaned = content
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // 图片
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 链接保留 label
    .replace(/[*_`~#>-]/g, '') // markdown 装饰
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '...' : cleaned;
}

// 算下次触发时刻: 用 rrule 在 (lastFire, now+far_future] 范围内找第一个 occurrence
// 前端只传简短 "FREQ=DAILY" 这种 (不含 DTSTART), 这里用 lastFire 作 dtstart 锚点
// 用户高级模式可能传完整含 DTSTART 的 RRULE, 这种走原生解析
// 若 RRULE 已无下次 (例如 UNTIL 已过) 返回 null
function computeNextDue(rrule: string, lastFire: Date): string | null {
  try {
    const hasDtstart = /DTSTART/i.test(rrule);
    let rule: RRuleType;
    if (hasDtstart) {
      rule = RRule.fromString(rrule);
    } else {
      const opts = RRule.parseString(rrule);
      rule = new RRule({ ...opts, dtstart: lastFire });
    }
    const next = rule.after(lastFire, false);
    return next ? next.toISOString() : null;
  } catch (e) {
    console.error('[reminder/scheduler] RRULE 解析失败:', rrule, e);
    return null;
  }
}

// 给一个 userId 发提醒: dispatch channels + publish SSE + 写通知中心. 笔记被删时改发"失效"通知不走 channel
async function deliverToUser(userId: string, note: { id: string; content: string; deletedAt: string | null }, payload: ReminderPayload, source: 'personal' | 'group', extraPayload?: Record<string, any>) {
  if (note.deletedAt) {
    // 笔记已被软删: 不发 channel (用户没必要再看到旧 todo), 只写一条"失效"通知
    createNotification(userId, 'reminder', 'reminder-expired',
      '提醒已失效', `「${extractPreview(note.content, 40)}」已被删除`,
      { noteId: note.id, source, ...(extraPayload || {}) },
    ).catch(() => {});
    return;
  }
  await dispatchToAllChannels(userId, payload);
  publish(userId, 'note-updated', { noteId: note.id });
  createNotification(userId, 'reminder', source === 'group' ? 'group-reminder-due' : 'reminder-due',
    payload.title, payload.body,
    { noteId: note.id, remindAt: payload.remindAt, source, ...(extraPayload || {}) },
  ).catch(() => {});
}

async function tick() {
  const nowIso = dayjs().toISOString();

  // ── 1) 个人提醒 (PR #11) ──
  // due_at <= now AND remind_sent_at IS NULL. 命中后 deliver + RRULE 推算下次 / 否则删行
  const personalRows = await db.select().from(schema.notePersonalReminders).where(and(
    sql`${schema.notePersonalReminders.dueAt} <= ${nowIso}`,
    sql`${schema.notePersonalReminders.remindSentAt} IS NULL`,
  )).all();

  for (const r of personalRows) {
    const note = await db.select({
      id: schema.notes.id,
      content: schema.notes.content,
      deletedAt: schema.notes.deletedAt,
    }).from(schema.notes).where(eq(schema.notes.id, r.noteId)).get();
    if (!note) {
      // 笔记被永久删. 删该行避免反复扫
      await db.delete(schema.notePersonalReminders).where(eq(schema.notePersonalReminders.id, r.id));
      continue;
    }
    const preview = extractPreview(note.content);
    const payload: ReminderPayload = {
      noteId: note.id,
      title: '待办提醒',
      body: preview || '(无内容)',
      remindAt: r.dueAt,
    };
    // 先标 sent_at (防 dispatch 慢时被下一次 tick 重复捞到)
    const sentAt = dayjs().toISOString();
    await db.update(schema.notePersonalReminders)
      .set({ remindSentAt: sentAt })
      .where(eq(schema.notePersonalReminders.id, r.id));

    await deliverToUser(r.userId, note, payload, 'personal');

    if (r.rrule) {
      const next = computeNextDue(r.rrule, new Date(r.dueAt));
      if (next) {
        await db.update(schema.notePersonalReminders)
          .set({ dueAt: next, remindSentAt: null })
          .where(eq(schema.notePersonalReminders.id, r.id));
      } else {
        // RRULE 无下次: 删行 (单次发完留痕跟"已失效"语义混淆, 统一删)
        await db.delete(schema.notePersonalReminders).where(eq(schema.notePersonalReminders.id, r.id));
      }
    } else {
      // 单次发完删行
      await db.delete(schema.notePersonalReminders).where(eq(schema.notePersonalReminders.id, r.id));
    }
  }

  // ── 2) 群提醒 (PR #11) ──
  // 命中后给群所有 active 成员发, 跳过关闭接收开关的成员. 笔记被删: 所有成员都收"失效"通知
  const groupRows = await db.select().from(schema.noteGroupReminders).where(and(
    sql`${schema.noteGroupReminders.dueAt} <= ${nowIso}`,
    sql`${schema.noteGroupReminders.remindSentAt} IS NULL`,
  )).all();

  for (const r of groupRows) {
    const note = await db.select({
      id: schema.notes.id,
      content: schema.notes.content,
      deletedAt: schema.notes.deletedAt,
    }).from(schema.notes).where(eq(schema.notes.id, r.noteId)).get();
    if (!note) {
      await db.delete(schema.noteGroupReminders).where(eq(schema.noteGroupReminders.id, r.id));
      continue;
    }
    // 群名给通知 body 用
    const grp = await db.select({ name: schema.groups.name }).from(schema.groups)
      .where(eq(schema.groups.id, r.groupId)).get();
    const preview = extractPreview(note.content);
    const payload: ReminderPayload = {
      noteId: note.id,
      title: `群提醒: ${grp?.name || '群组'}`,
      body: preview || '(无内容)',
      remindAt: r.dueAt,
    };
    const sentAt = dayjs().toISOString();
    await db.update(schema.noteGroupReminders)
      .set({ remindSentAt: sentAt })
      .where(eq(schema.noteGroupReminders.id, r.id));

    // 拉所有 active 成员 + 接收开关
    const members = await db.select({ userId: schema.groupMembers.userId }).from(schema.groupMembers)
      .where(and(
        eq(schema.groupMembers.groupId, r.groupId),
        eq(schema.groupMembers.status, 'active'),
      )).all();
    if (members.length > 0) {
      const memberIds = members.map(m => m.userId);
      const subs = await db.select().from(schema.groupReminderSubscriptions)
        .where(and(
          eq(schema.groupReminderSubscriptions.groupId, r.groupId),
          inArray(schema.groupReminderSubscriptions.userId, memberIds),
        )).all();
      const subMap = new Map(subs.map(s => [s.userId, s.enabled]));
      // 默认接收 (subMap 缺行视作 true), 显式 enabled=false 才跳过
      for (const m of memberIds) {
        if (subMap.get(m) === false) continue;
        await deliverToUser(m, note, payload, 'group', { groupId: r.groupId, createdBy: r.createdBy });
      }
    }

    if (r.rrule) {
      const next = computeNextDue(r.rrule, new Date(r.dueAt));
      if (next) {
        await db.update(schema.noteGroupReminders)
          .set({ dueAt: next, remindSentAt: null })
          .where(eq(schema.noteGroupReminders.id, r.id));
      } else {
        await db.delete(schema.noteGroupReminders).where(eq(schema.noteGroupReminders.id, r.id));
      }
    } else {
      await db.delete(schema.noteGroupReminders).where(eq(schema.noteGroupReminders.id, r.id));
    }
  }

  // ── 3) 老 notes.todo_due 路径 (PR #11a 兼容期, 11c 移除) ──
  // 11a 后端 ship 但 11b 前端没 ship 时, 老前端仍 PATCH notes.todo_due. 这里继续扫保持兼容.
  // 蘑菇规则: 11b 切完前端走新接口后, scheduler 此分支可删 (注释里标 TODO)
  const legacyRows = await db.select().from(schema.notes).where(and(
    eq(schema.notes.type, 'todo'),
    sql`${schema.notes.deletedAt} IS NULL`,
    sql`${schema.notes.todoStatus} IS NOT 'done'`,
    isNotNull(schema.notes.todoDue),
    sql`${schema.notes.todoDue} <= ${nowIso}`,
    sql`${schema.notes.todoRemindSentAt} IS NULL`,
  )).all();

  for (const note of legacyRows) {
    // 同步迁移到新表 (按 user_id+note_id 主键 upsert), 让数据慢慢汇拢
    // 如已存在 personal_reminders (新接口先创建过) → 跳过避免 conflict 覆盖新值
    const exists = await db.select({ id: schema.notePersonalReminders.id }).from(schema.notePersonalReminders)
      .where(and(
        eq(schema.notePersonalReminders.userId, note.userId),
        eq(schema.notePersonalReminders.noteId, note.id),
      )).get();
    if (exists) {
      // 已有新表条目 - 标老的 sent 防重复扫, 不再发 (新表已经处理过 / 即将处理)
      await db.update(schema.notes)
        .set({ todoRemindSentAt: dayjs().toISOString() })
        .where(eq(schema.notes.id, note.id));
      continue;
    }

    const preview = extractPreview(note.content);
    const payload: ReminderPayload = {
      noteId: note.id,
      title: '待办提醒',
      body: preview || '(无内容)',
      remindAt: note.todoDue!,
    };
    const sentAt = dayjs().toISOString();
    await db.update(schema.notes)
      .set({ todoRemindSentAt: sentAt })
      .where(eq(schema.notes.id, note.id));

    await deliverToUser(note.userId, note, payload, 'personal');

    if (note.todoRemindRrule) {
      const nextDue = computeNextDue(note.todoRemindRrule, new Date(note.todoDue!));
      if (nextDue) {
        await db.update(schema.notes)
          .set({ todoDue: nextDue, todoRemindSentAt: null })
          .where(eq(schema.notes.id, note.id));
      }
    }
  }

  const total = personalRows.length + groupRows.length + legacyRows.length;
  if (total > 0) console.log(`[reminder/scheduler] tick: personal=${personalRows.length}, group=${groupRows.length}, legacy=${legacyRows.length}`);
}

export function startReminderScheduler() {
  if (timer) return;
  // 启动后先延迟 5s 跑首次, 让 server 完全 ready (DB / 路由都挂好)
  setTimeout(() => {
    tick().catch(e => console.error('[reminder/scheduler] tick 失败:', e));
    timer = setInterval(() => {
      tick().catch(e => console.error('[reminder/scheduler] tick 失败:', e));
    }, SCAN_INTERVAL_MS);
  }, 5_000);
  console.log('[reminder/scheduler] 启动, 每 60s 扫一次');
}

export function stopReminderScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
