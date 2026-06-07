// 每个浏览器 tab / Electron 窗口生成唯一 clientId, 存 sessionStorage (每 tab 独立, 不跨 tab 共享).
// 用途: 所有写操作 API 请求带 X-Quink-Client-Id header, server publish SSE 时把 originClientId 附在 payload.
// 前端 SSE handler 检查 _originClientId === 自己 clientId → 是则跳过 (本设备已经在 PATCH/POST 时直接 mutate UI, 不需要 SSE 二次触发).
//
// 为啥 sessionStorage 不是 localStorage: localStorage 跨 tab 共享 → 一个 tab 写另一个 tab 收不到自己发的 SSE → 永远跳过 → 其他 tab 看不到更新.
// sessionStorage 每 tab 独立, A tab 写时 originClientId=A, B tab 收到时 _originClientId=A ≠ B → 不跳过 → B 正常处理.

const CLIENT_ID_KEY = 'quink_client_id';
let cached: string | null = null;

export function getClientId(): string {
  if (cached) return cached;
  try {
    let id = sessionStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(CLIENT_ID_KEY, id);
    }
    cached = id;
    return id;
  } catch {
    // sessionStorage 不可用 (隐私模式 / 服务端渲染) 兜底
    cached = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    return cached;
  }
}

// SSE handler 收到事件时调: payload 里的 _originClientId 是发起方设备的 clientId. 等于本机 → 本设备自己发的, 跳过.
export function isMyEvent(data: any): boolean {
  return data && typeof data._originClientId === 'string' && data._originClientId === getClientId();
}
