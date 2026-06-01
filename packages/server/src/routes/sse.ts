import { Hono } from 'hono';
import { verifyToken } from '../auth.js';
import { subscribe } from '../reminder/bus.js';

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

    // 15s 一次心跳, 防 nginx / 代理 / Electron 网络层把空闲连接掐掉; SSE 注释行 ":xxx\n\n" 客户端会丢弃但保持连接
    heartbeat = setInterval(() => {
      if (closed) { cleanup(); return; }
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
