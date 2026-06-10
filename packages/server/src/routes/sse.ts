import { Hono } from 'hono';
import { verifyToken } from '../auth.js';
import { subscribe, onPresenceChange, publish } from '../reminder/bus.js';
import { db, schema } from '../db/index.js';
import { and, eq, isNull, gte, inArray } from 'drizzle-orm';
import dayjs from 'dayjs';

// 上下线广播: bus 检测到某 user 第一条 SSE 上线 / 最后一条断开时, 给该 user 所有共同群成员推送 presence-changed.
// 模块加载时注册一次, 不要在每个 connect 里注册 (否则同一事件被推 N 次)
onPresenceChange((userId, online) => {
  void broadcastPresence(userId, online);
});

async function broadcastPresence(userId: string, online: boolean) {
  try {
    // 该用户所在所有 active 群组. 排除 hidePresence=true 的群 (该群成员不知道 userId 上下线).
    // 但隐身用户仍能正常收事件 (隐身只单向屏蔽"我向群里广播", 不影响"我收群里事件")
    const myGroups = await db.select({ groupId: schema.groupMembers.groupId })
      .from(schema.groupMembers)
      .where(and(
        eq(schema.groupMembers.userId, userId),
        eq(schema.groupMembers.status, 'active'),
        eq(schema.groupMembers.hidePresence, false),
      ))
      .all();
    if (myGroups.length === 0) return;
    const groupIds = myGroups.map(g => g.groupId);
    // 这些群的所有 active 成员 (去重, 排除本人 - 自己刚上线不需要通知自己)
    const otherMembers = await db.select({ userId: schema.groupMembers.userId })
      .from(schema.groupMembers)
      .where(and(
        inArray(schema.groupMembers.groupId, groupIds),
        eq(schema.groupMembers.status, 'active'),
      ))
      .all();
    const seen = new Set<string>();
    for (const m of otherMembers) {
      if (m.userId !== userId && !seen.has(m.userId)) {
        seen.add(m.userId);
        publish(m.userId, 'presence-changed', { userId, online });
      }
    }
  } catch (e) {
    console.error('[sse] broadcastPresence failed:', e);
  }
}

// 补送 browser channel 离线期间挂起的提醒. 24h 内未送达的才补 (太老了像 spam).
// atomic update sentAt 保证多端登录只推一次, where sentAt IS NULL 防重复送
async function flushPendingReminders(userId: string, write: (event: string, data: string) => Promise<unknown>) {
  const cutoff = dayjs().subtract(24, 'hour').toISOString();
  const rows = await db.select().from(schema.reminderPending)
    .where(and(
      eq(schema.reminderPending.userId, userId),
      isNull(schema.reminderPending.sentAt),
      gte(schema.reminderPending.createdAt, cutoff),
    )).all();
  if (rows.length === 0) return;
  console.log(`[sse] user ${userId} 上线, 补送 ${rows.length} 条 pending reminder`);
  const now = dayjs().toISOString();
  for (const row of rows) {
    try {
      // 推 reminder 事件给前端, payload 是当时存进去的 JSON 字符串 (跟实时 reminder 同格式)
      await write('reminder', row.payload);
      // atomic mark sent: 仅在 sent_at 仍是 NULL 时 update (其他端可能已经抢先 mark)
      await db.update(schema.reminderPending)
        .set({ sentAt: now })
        .where(and(eq(schema.reminderPending.id, row.id), isNull(schema.reminderPending.sentAt)));
    } catch {
      // SSE 写失败 (客户端断了), 留 pending 等下次重连补送
      return;
    }
  }
}

const app = new Hono();

// GET /api/sse?token=xxx
// EventSource 不支持自定义 header, 所以走 query token. token 跟 Authorization Bearer 用同一 JWT, 不另发
// 注意: 此路由不挂 authMiddleware (因为 middleware 只看 header). 自己校验 query token.
app.get('/', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: '缺少 token' }, 401);
  const payload = verifyToken(token);
  if (!payload) return c.json({ error: '登录已过期' }, 401);
  const userId = payload.sub;

  // 校验 tokenVersion 跟 DB 一致 (跟 authMiddleware / 静态文件中间件对齐).
  // 改密码后 users.token_version++ → 旧 token 携带 tv 跟 DB 不匹配, 拒绝建立 SSE 连接
  const tvRow = await db.select({ tokenVersion: schema.users.tokenVersion })
    .from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!tvRow) return c.json({ error: '用户不存在' }, 401);
  if ((payload.tv ?? 0) !== (tvRow.tokenVersion ?? 0)) {
    return c.json({ error: '登录已失效, 请重新登录' }, 401);
  }
  const initialTv = tvRow.tokenVersion ?? 0;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  let closed = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (unsubscribe) unsubscribe();
    // writer.close() 在 stream 已被对端 cancel 时会同步抛 ERR_INVALID_STATE (Node 22 webstream),
    // 用 abort 不抛错; 仍包 try/catch 兜底
    try { writer.abort().catch(() => {}); } catch {}
  };

  const write = (event: string, data: string) => {
    if (closed) return Promise.reject(new Error('connection closed'));
    // SSE 格式: "event: <name>\ndata: <json>\n\n" (单 \n 分隔字段, 双 \n\n 结束一帧)
    return writer.write(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
  };

  // IIFE 异步, 不阻塞 Response 返回. 跟 ai-chat 同模式: Response 立即带 stream 头返回客户端,
  // 浏览器收到 200 + Content-Type 才会触发 EventSource onopen 事件.
  (async () => {
    try {
      await write('ready', JSON.stringify({ ts: Date.now() }));
    } catch {
      cleanup();
      return;
    }

    unsubscribe = subscribe(userId, (event, data) => {
      write(event, data).catch(() => cleanup());
    });

    // 上线后补送离线期间挂起的 browser reminder. 不阻塞 (后续实时 reminder 仍走 subscribe 推送)
    flushPendingReminders(userId, write).catch(e => console.error('[sse] flush pending failed:', e));

    // 15s 一次心跳, 防 nginx / 代理 / Electron 网络层把空闲连接掐掉; SSE 注释行 ":xxx\n\n" 客户端会丢弃但保持连接
    // 每 4 次心跳 (60s) 校验一次 tokenVersion, 防长连接绕过改密失效. DB 临时失败 try/catch 兜底不断连接
    let beatCount = 0;
    heartbeat = setInterval(async () => {
      if (closed) { cleanup(); return; }
      beatCount++;
      if (beatCount % 4 === 0) {
        try {
          const cur = await db.select({ tokenVersion: schema.users.tokenVersion })
            .from(schema.users).where(eq(schema.users.id, userId)).get();
          if (!cur || initialTv !== (cur.tokenVersion ?? 0)) {
            cleanup();
            return;
          }
        } catch {}
      }
      writer.write(encoder.encode(`:hb\n\n`)).catch(() => cleanup());
    }, 15_000);
  })();

  // 客户端断开会导致下一次 write 抛错, 由 cleanup 处理
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // 让反向代理不缓冲
    },
  });
});

export default app;
