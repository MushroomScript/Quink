import { db, schema } from '../db/index.js';
import { eq, and, sql, isNotNull } from 'drizzle-orm';
import dayjs from 'dayjs';
// rrule 2.8.1 是 UMD/webpack 打包, Node ESM 走 cjs interop 时只能从 default 拿 RRule 类的值.
// 直接 named import 会抛 "does not provide an export named 'RRule'". 走 default 再解构.
// 类型走 import type {} from 'rrule' (TS 走 .d.ts 直接通, 跟运行时 cjs interop 解耦)
import rrulePkg from 'rrule';
import type { RRule as RRuleType } from 'rrule';
const { RRule } = rrulePkg;
import { dispatchToAllChannels } from './sender.js';
import type { ReminderPayload } from './types.js';

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

async function tick() {
  const nowIso = dayjs().toISOString();
  // 命中条件:
  //   type = 'todo'
  //   deletedAt IS NULL (回收站跳过)
  //   todoStatus != 'done' (已完成的不再提醒, 即使有 rrule)
  //   todoDue <= now
  //   todoRemindSentAt IS NULL (从未发过)
  // 注意有 rrule 的待办在发完后我们会推算下次 todoDue, 不会停留在过去时间, 所以"未发过 + 未来时间"自然处理重复
  const rows = await db.select().from(schema.notes).where(and(
    eq(schema.notes.type, 'todo'),
    sql`${schema.notes.deletedAt} IS NULL`,
    sql`${schema.notes.todoStatus} IS NOT 'done'`,
    isNotNull(schema.notes.todoDue),
    sql`${schema.notes.todoDue} <= ${nowIso}`,
    sql`${schema.notes.todoRemindSentAt} IS NULL`,
  )).all();

  if (rows.length === 0) return;
  console.log(`[reminder/scheduler] tick: ${rows.length} 待发`);

  for (const note of rows) {
    const preview = extractPreview(note.content);
    const payload: ReminderPayload = {
      noteId: note.id,
      title: '待办提醒',
      body: preview || '(无内容)',
      remindAt: note.todoDue!,
    };

    // 先标 sent_at (防 dispatch 慢时被下一次 tick 重复捞到), 再发送
    const sentAt = dayjs().toISOString();
    await db.update(schema.notes)
      .set({ todoRemindSentAt: sentAt })
      .where(eq(schema.notes.id, note.id));

    // 发送 (失败不抛, sender 内部已 catch + log)
    await dispatchToAllChannels(note.userId, payload);

    // 有 rrule 推算下次, 重置 sent_at = null
    if (note.todoRemindRrule) {
      const nextDue = computeNextDue(note.todoRemindRrule, new Date(note.todoDue!));
      if (nextDue) {
        await db.update(schema.notes)
          .set({ todoDue: nextDue, todoRemindSentAt: null })
          .where(eq(schema.notes.id, note.id));
        console.log(`[reminder/scheduler] note ${note.id} 下次触发 ${nextDue}`);
      } else {
        console.log(`[reminder/scheduler] note ${note.id} RRULE 已无下次, 停止`);
      }
    }
  }
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
