// Hono Context augmentation: 让 c.get('userId') / c.set('userId', x) 在所有 route 里
// 都精确返回 string,而不是 unknown / never。authMiddleware 在 set 时类型也校验。
// 避免每个 route 单独 new Hono<{ Variables: { userId: string } }>() 重复 generic。
import 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    // 发起方 tab/窗口的 clientId (X-Quink-Client-Id header), index.ts 的全局中间件写入.
    // 写 endpoint 透传给 publish, 让发起设备的 SSE 跳过自己发的事件.
    // 可选: 中间件之前的路径 / 没带这个 header 的客户端都拿到 undefined, 跟原来直读 header 同义
    ocid: string | undefined;
  }
}
