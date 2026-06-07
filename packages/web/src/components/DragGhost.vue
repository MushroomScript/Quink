<script setup lang="ts">
// 卡片拖动期间的浮动 ghost (Teleport to body + fixed + pointer-events:none, 跟随鼠标).
// state 由 utils/cardDnd 提供, 这里只 reactive 渲染.
// 网页 CSS zoom: ghostX/Y 是 e.clientX/Y zoomed 坐标, 但 fixed + inline px style 渲染会再 * zoom 一次 → 飞偏 zoom^2. 用 helper 除掉 zoom 让 inline 是 unzoomed px (Electron 端 helper 返 1 无副作用)
import { computed } from 'vue';
import { dragState } from '@/utils/cardDnd';
import { getCssZoom } from '@/utils/zoom';

const ghostStyle = computed(() => {
  const z = getCssZoom();
  return {
    left: ((dragState.ghostX + 12) / z) + 'px',
    top: ((dragState.ghostY + 12) / z) + 'px',
  };
});
</script>

<template>
  <Teleport to="body">
    <div v-if="dragState.active"
      class="pointer-events-none fixed z-[var(--z-overlay)]"
      :style="ghostStyle">
      <div class="bg-white border border-gray-300 rounded-lg shadow-lg px-3 py-1.5 text-xs text-gray-700 max-w-[280px] opacity-90 ghost-text-preview">
        {{ dragState.ghostText }}
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 保留 markdown 原文换行 + 多行限制 (max-height 替代 line-clamp 因为后者跟 white-space: pre-line 行为冲突 webkit-box 渲染会让内容消失). 跟 NoteCard.text 计算保持 120 字截断一致 */
.ghost-text-preview {
  white-space: pre-line;
  word-break: break-word;
  overflow: hidden;
  max-height: 4.5em; /* ~3 行 (line-height 1.5) */
  line-height: 1.5;
}
</style>
