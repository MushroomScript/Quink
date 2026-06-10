// SSE 事件总线
// scheduler 触发 browser adapter -> bus.publish(userId, ...) -> src/sse.ts 注册的 subscriber 收到 -> 写 SSE 数据
// 多端登录场景: 同一 userId 可能有多个 SSE 连接, 全部推送一份(用户多设备同时通知)
//
// Presence: subscribers 数量天然反映"用户是否在线". size 从 0→1 视为上线, 从 1→0 视为下线.
// onPresenceChange 让 sse.ts 在上下线时给同群成员广播 presence-changed 事件

type Subscriber = (event: string, data: string) => void;
type PresenceListener = (userId: string, online: boolean) => void;

const subscribers = new Map<string, Set<Subscriber>>();
const presenceListeners = new Set<PresenceListener>();

function emitPresence(userId: string, online: boolean) {
  for (const cb of presenceListeners) {
    try { cb(userId, online); } catch (e) { console.error('[reminder/bus] presence listener failed:', e); }
  }
}

// 单账号 SSE 连接数上限. 防恶意账号开 100 个连接占内存 + 让 heartbeat 每 15s 写 100 次.
// 个人使用场景一台机 1-2 连接足够, 10 个上限留缓冲 (跨设备 + 多 tab 并存). 超出最早进入的连接被踢
const MAX_SUBSCRIBERS_PER_USER = 10;

export function subscribe(userId: string, write: Subscriber): () => void {
  const wasEmpty = !subscribers.has(userId) || subscribers.get(userId)!.size === 0;
  if (!subscribers.has(userId)) subscribers.set(userId, new Set());
  const set = subscribers.get(userId)!;

  // 超额时踢最早进入的连接 (Set 迭代序 = 插入序)
  while (set.size >= MAX_SUBSCRIBERS_PER_USER) {
    const oldest = set.values().next().value;
    if (oldest) {
      set.delete(oldest);
      // 通知最早的 writer 它被踢 (sse.ts handler 会 cleanup), 失败 swallow
      try { oldest('connection-superseded', JSON.stringify({ reason: 'sse_limit_exceeded' })); } catch {}
    } else break;
  }

  set.add(write);
  if (wasEmpty) emitPresence(userId, true);
  return () => {
    const set = subscribers.get(userId);
    if (!set) return;
    set.delete(write);
    if (set.size === 0) {
      subscribers.delete(userId);
      emitPresence(userId, false);
    }
  };
}

// originClientId: 发起方 tab/窗口的 clientId (前端 X-Quink-Client-Id header, endpoint handler 从 c.req.header 读). 附在 payload, 前端 SSE handler 跳过自己发的事件.
// 不传 originClientId (如 scheduler / presence 等"非用户触发"事件) → payload 不附字段, 所有设备都正常处理.
export function publish(userId: string, event: string, data: any, originClientId?: string): boolean {
  const subs = subscribers.get(userId);
  if (!subs || subs.size === 0) return false;
  const payload = originClientId !== undefined ? { ...data, _originClientId: originClientId } : data;
  const json = JSON.stringify(payload);
  let delivered = false;
  for (const write of subs) {
    try {
      write(event, json);
      delivered = true;
    } catch (e) {
      console.error('[reminder/bus] subscriber write failed:', e);
    }
  }
  return delivered;
}

export function hasSubscribers(userId: string): boolean {
  const subs = subscribers.get(userId);
  return !!subs && subs.size > 0;
}

export function isOnline(userId: string): boolean {
  return hasSubscribers(userId);
}

export function getOnlineUserIds(): string[] {
  return Array.from(subscribers.keys());
}

export function onPresenceChange(cb: PresenceListener): () => void {
  presenceListeners.add(cb);
  return () => { presenceListeners.delete(cb); };
}
