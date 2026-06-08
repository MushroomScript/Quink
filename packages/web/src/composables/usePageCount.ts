import { ref } from 'vue';

// 全局 pageCount: view 给 TopBar banner "（N）" 显示页面计数. -1 = 隐藏.
//
// 为啥不用 provide/inject: TopBar 跟 RouterView 在 App.vue 里是 sibling (不是父子),
// provide 在 view 里 inject 在 TopBar 里走不到 — Resources/Tags/Trash 历史代码都
// provide('pageCount', ...) 但实际 banner 一直没显示 (N), 没人发现.
//
// 用法 (view setup):
//   import { sharedPageCount } from '@/composables/usePageCount';
//   const myCount = computed(() => ...);
//   watchEffect(() => { sharedPageCount.value = myCount.value; });
//   onUnmounted(() => { sharedPageCount.value = -1; });
//
// TopBar 直接 import + 读. 切 view 时 onUnmounted 清零防残留.
export const sharedPageCount = ref(-1);
