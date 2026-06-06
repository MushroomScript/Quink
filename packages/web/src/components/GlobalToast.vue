<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useToast } from '@/composables/useToast';
import { unzoomRect } from '@/utils/zoom';
const { toasts, dismiss, pause, resume } = useToast();

// 容器顶部实时对齐搜索栏顶部. 用 rAF 持续校正, 覆盖 TopBar 高度变化 / Electron
// 标题栏延迟 mount / 主题切换字体高度差 / filter bar 展开 / 首屏 layout 抖动 等
// 所有 searchBox 位置变化场景. 只在有 toast 时跑, 避免空转.
// 移动端搜索栏 display:none (offsetParent 为 null), 退回 header top + 8.
const topOffset = ref('14px');
let rafId: number | null = null;

function measureOffset(): string {
  // unzoomRect: CSS zoom 下 toast 用 fixed 顶部对齐, rect 跟 inline top 单位要归一
  const searchBox = document.querySelector('[data-search-box]') as HTMLElement | null;
  if (searchBox && searchBox.offsetParent !== null) {
    return `${unzoomRect(searchBox).top}px`;
  }
  const header = document.querySelector('header');
  if (header) return `${unzoomRect(header).top + 8}px`;
  return '14px';
}

function tick() {
  const next = measureOffset();
  if (next !== topOffset.value) topOffset.value = next;
  rafId = requestAnimationFrame(tick);
}

function startTracking() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(tick);
}

function stopTracking() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// 有 toast → 开启 rAF; 无 toast → 停. 数组从 0 跳到 N 的瞬间立刻校正一次,
// 避免新 toast 出现时还停留在上一次缓存值上.
watch(() => toasts.value.length, (len) => {
  if (len > 0) startTracking();
  else stopTracking();
});

onMounted(() => {
  topOffset.value = measureOffset();
  if (toasts.value.length > 0) startTracking();
});

onUnmounted(stopTracking);

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
    class="fixed left-1/2 -translate-x-1/2 z-[var(--z-overlay)] flex flex-col gap-2 items-center pointer-events-none"
    :style="{ top: topOffset }"
    enter-active-class="transition-[opacity,transform] duration-300 ease-out"
    enter-from-class="!opacity-0 -translate-y-8"
    enter-to-class="translate-y-0"
    leave-active-class="absolute transition-[opacity,transform] duration-300 ease-in"
    leave-from-class="translate-y-0"
    leave-to-class="!opacity-0 -translate-y-8"
    move-class="transition-transform duration-300 ease-out"
  >
    <div v-for="t in toasts" :key="t.id"
      class="px-4 py-1.5 rounded-full text-sm font-medium text-white select-none shadow-lg flex items-center gap-3 transform-gpu"
      :style="{ opacity: 0.92 }"
      :class="[
        t.action ? 'pointer-events-auto' : 'pointer-events-none',
        t.kind === 'error' ? 'bg-red-500' : 'bg-primary',
      ]"
      @mouseenter="onHoverEnter(t.id, !!t.action)"
      @mouseleave="onHoverLeave(t.id, !!t.action)"
    >
      <!-- relative -top-px: 补偿 YaHei 字体 metrics 不对称导致字符墨迹中心比 inline-box geometric center 偏下 1px
           (上方 leading 4px > 下方 leading 2px → 字符视觉居中需要往上 1px). 用 relative top 而非 toast padding 调整,
           让按钮按 flex items-center 自然在 box 几何中心, 不受字符补偿影响. -->
      <span class="whitespace-nowrap relative -top-px">{{ t.message }}</span>
      <!-- PR #5b: error kind 用白字 (避免 toast-undo-btn 的红字 #FF3B3B 撞 bg-red-500 红底);
           default kind 保留 toast-undo-btn 原红字 (主题色背景 + 红字撤销风格) -->
      <button v-if="t.action"
        @click="onAction(t.id, t.action.onClick)"
        :class="[
          'text-sm underline underline-offset-2 cursor-pointer whitespace-nowrap transition-colors relative -top-px',
          t.kind === 'error' ? 'text-white opacity-90 hover:opacity-100' : 'toast-undo-btn',
        ]"
      >
        {{ t.action.label }}
      </button>
    </div>
  </TransitionGroup>
</template>
