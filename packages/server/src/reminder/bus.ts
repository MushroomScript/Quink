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

export function subscribe(userId: string, write: Subscriber): () => void {
  const wasEmpty = !subscribers.has(userId) || subscribers.get(userId)!.size === 0;
  if (!subscribers.has(userId)) subscribers.set(userId, new Set());
  subscribers.get(userId)!.add(write);
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

export function publish(userId: string, event: string, data: any): boolean {
  const subs = subscribers.get(userId);
  if (!subs || subs.size === 0) return false;
  const json = JSON.stringify(data);
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
