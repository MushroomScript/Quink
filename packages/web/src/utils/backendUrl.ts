// 后端直连 URL helper. 用于 SSE / AI Chat 流式响应等长连接, 绕开 vite proxy.
//
// 绕 vite proxy 的原因: vite 的 http-proxy 转发 SSE / fetch 流式长连接时, 在重连 / 上游事件场景
// 会泄漏 socket. 浏览器对 :24888 的 HTTP/1.1 池 (默认 6 个并发) 被 active 状态的"僵尸 socket"
// 占满 → 新 fetch 排队 → "Initial connection: Stalled" → 整页 API pending 后 cancel.
// Flush Socket Pools 只清 idle socket 救不回, 必须关掉所有同 origin 标签让网络栈清空.
//
// 直连 backend 让长连接走独立的 (host, port) 池子, 跟普通 API 完全隔离.
// backend hono cors() 默认放行所有 origin 跟 Authorization 等常用 header, 跨 origin 无副作用
// (preflight OPTIONS 会多一次 RTT, 长流场景可忽略).
//
// 兼容手机连 PC 局域网 IP (vite host:true 模式): location.hostname 跟着切到 PC IP, 拼出来的
// backend URL 也是 PC IP, 手机能连得到 (PC 防火墙需放行 38999, 跟 24888 同款配置).
//
// prod 模式 (打包后): 返回空字符串, 调用方拼出来还是 `/api/xxx` 相对路径走同 origin,
// 假设部署时 backend 跟 frontend 在同 origin (nginx 反代 / Electron 内置后端等).
export function backendBaseUrl(): string {
  if (!import.meta.env.DEV) return '';
  return `${window.location.protocol}//${window.location.hostname}:38999`;
}
