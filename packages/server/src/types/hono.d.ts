// Hono Context augmentation: 让 c.get('userId') / c.set('userId', x) 在所有 route 里
// 都精确返回 string,而不是 unknown / never。authMiddleware 在 set 时类型也校验。
// 避免每个 route 单独 new Hono<{ Variables: { userId: string } }>() 重复 generic。
import 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
  }
}
