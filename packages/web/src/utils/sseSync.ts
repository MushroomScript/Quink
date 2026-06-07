// View 监听 SSE 'data-changed' 事件触发本地 refresh 的 composable.
// 后端写 endpoint publish(userId, 'data-changed', { scope }, _ocid) → 前端 sse.ts 派 quink-{scope}-changed CustomEvent → view 用本 helper 监听.
// 发起方设备靠 isMyEvent 跳过自己发的事件 (本机已经直接 mutate UI 不需要 SSE 二次触发).
//
// 用法 (view setup 内):
//   import { useSseSync } from '@/utils/sseSync';
//   useSseSync('categories', loadCategories);          // 单 scope
//   useSseSync(['ai-configs', 'ai-prompts'], reload);  // 多 scope 共用一个 refresh fn

import { onMounted, onUnmounted } from 'vue';

export function useSseSync(scope: string | string[], refresh: () => void) {
  const scopes = Array.isArray(scope) ? scope : [scope];
  const handler = () => refresh();
  onMounted(() => {
    for (const s of scopes) {
      window.addEventListener(`quink-${s}-changed`, handler);
    }
  });
  onUnmounted(() => {
    for (const s of scopes) {
      window.removeEventListener(`quink-${s}-changed`, handler);
    }
  });
}
