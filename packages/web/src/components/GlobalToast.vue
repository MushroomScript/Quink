<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useToast } from '@/composables/useToast';
const { toasts, dismiss, pause, resume } = useToast();

// toast 顶部跟搜索栏顶部对齐 (桌面端); 移动端搜索栏隐藏时落到 TopBar Main bar 顶部
// 用 ResizeObserver 监听 TopBar 高度变化, window resize 兜底 Electron 标题栏 mount / 断点切换
const topOffset = ref('14px');
let resizeObs: ResizeObserver | null = null;

function updateOffset() {
  const searchBox = document.querySelector('[data-search-box]') as HTMLElement | null;
  // searchBox display:none (hidden md:block) 在 mobile 下 bbox 为 0, 退回 header top + 8
  if (searchBox && searchBox.offsetParent !== null) {
    topOffset.value = `${searchBox.getBoundingClientRect().top}px`;
    return;
  }
  const header = document.querySelector('header');
  if (header) topOffset.value = `${header.getBoundingClientRect().top + 8}px`;
}

onMounted(() => {
  updateOffset();
  const header = document.querySelector('header');
  if (header) {
    resizeObs = new ResizeObserver(updateOffset);
    resizeObs.observe(header);
  }
  window.addEventListener('resize', updateOffset);
});

onUnmounted(() => {
  resizeObs?.disconnect();
  window.removeEventListener('resize', updateOffset);
});

async function onAction(id: number, handler: () => void | Promise<void>) {
  // 先关 toast 再跑 handler: 避免 await 期间用户多点导致重复 restore
  dismiss(id);
  try {
    await handler();
  } catch (e) {
    console.error('[toast action]', e);
  }
}

// 只有带 action 的 toast 才挂 hover 暂停 (普通 "已保存" 之类的让它正常超时消失,
// 不会因为光标偶尔扫过就赖在屏幕上)
function onHoverEnter(id: number, hasAction: boolean) {
  if (hasAction) pause(id);
}
function onHoverLeave(id: number, hasAction: boolean) {
  if (hasAction) resume(id);
}
</script>

<template>
  <!--
    叠加式 toast: 新 toast push 到数组末尾, DOM 顺序 [oldest, ..., newest].
    容器 top 对齐 + flex-col → oldest 在视觉顶部, newest 在视觉底部.

    性能要点 (多条同时进出最容易卡):
    1. leave-active 加 absolute 让退出元素脱离 flex 流, 保留原 static 位置 (top/left auto = 浏览器用 normal flow position),
       这样下方 staying toast 立即重排, 由 move-class 走 FLIP transform 平滑补位, 不会被 max-height 塌缩拖累
    2. enter / leave 只过渡 opacity + transform, 全程 GPU compositing 零 reflow
    3. 不再过渡 max-height / margin / padding (这些是 layout 属性, 每帧触发整树重排)
  -->
  <TransitionGroup
    tag="div"
    class="fixed left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 items-center pointer-events-none"
    :style="{ top: topOffset }"
    enter-active-class="transition-[opacity,transform] duration-300 ease-out"
    enter-from-class="opacity-0 -translate-y-8"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="absolute transition-[opacity,transform] duration-300 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 -translate-y-8"
    move-class="transition-transform duration-300 ease-out"
  >
    <div v-for="t in toasts" :key="t.id"
      class="px-4 py-1.5 rounded-full text-sm font-medium text-white select-none shadow-lg flex items-center gap-3"
      :class="[
        t.action ? 'pointer-events-auto' : 'pointer-events-none',
        t.kind === 'error' ? 'bg-red-500' : 'bg-primary',
      ]"
      @mouseenter="onHoverEnter(t.id, !!t.action)"
      @mouseleave="onHoverLeave(t.id, !!t.action)"
    >
      <span class="whitespace-nowrap">{{ t.message }}</span>
      <button v-if="t.action"
        @click="onAction(t.id, t.action.onClick)"
        class="text-xs font-semibold px-2 py-0.5 rounded-full bg-white/20 hover:bg-white/30 text-white transition-colors cursor-pointer"
      >
        {{ t.action.label }}
      </button>
    </div>
  </TransitionGroup>
</template>
