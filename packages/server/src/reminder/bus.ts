// SSE 事件总线
// scheduler 触发 browser adapter -> bus.publish(userId, ...) -> src/sse.ts 注册的 subscriber 收到 -> 写 SSE 数据
// 多端登录场景: 同一 userId 可能有多个 SSE 连接, 全部推送一份(用户多设备同时通知)

type Subscriber = (event: string, data: string) => void;

const subscribers = new Map<string, Set<Subscriber>>();

export function subscribe(userId: string, write: Subscriber): () => void {
  if (!subscribers.has(userId)) subscribers.set(userId, new Set());
  subscribers.get(userId)!.add(write);
  return () => {
    const set = subscribers.get(userId);
    if (!set) return;
    set.delete(write);
    if (set.size === 0) subscribers.delete(userId);
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
