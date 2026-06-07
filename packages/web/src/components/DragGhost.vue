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

// Vditor.md2html 输出的 HTML 元素之间带 \n text node (例如 `<p>1</p>\n<br>\n<p>2</p>\n`).
// 这些 \n 在 ghost 内 inline context 形成 anonymous inline box, BR 周围会额外拉高 line-height (~18px) → 视觉看像多了一行白边.
// 1) 清理元素之间的纯空白 text node (>\s+<  → ><) 让 layout 紧凑
// 2) 剥末尾 \n / \s / <br> 防末尾形成空白行
const ghostHtmlClean = computed(() => {
  let h = dragState.ghostHtml || '';
  h = h.replace(/>\s+</g, '><');                       // 元素间 \n / 空白 text node 清掉
  h = h.replace(/(\s|<br\s*\/?>)+$/i, '');             // 末尾 \n / br 剥掉
  return h;
});
</script>

<template>
  <Teleport to="body">
    <div v-if="dragState.active"
      class="pointer-events-none fixed z-[var(--z-overlay)]"
      :style="ghostStyle">
      <!-- 单选: 复用 NoteCard.renderedContent 的 HTML, v-html 渲染 + 外层 vditor-reset 复用 Vditor CSS (跟卡片视觉一致); 多选: 走 ghostText 兜底 "X 条内容" -->
      <div v-if="ghostHtmlClean"
        class="bg-white border border-gray-300 rounded-lg shadow-lg px-3 py-1.5 opacity-90 ghost-md-preview">
        <div class="vditor-reset" v-html="ghostHtmlClean" />
      </div>
      <div v-else
        class="bg-white border border-gray-300 rounded-lg shadow-lg px-3 py-1.5 text-xs text-gray-700 max-w-[280px] opacity-90 ghost-text-preview">
        {{ dragState.ghostText }}
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* HTML 预览 (单选 markdown 渲染). overflow hidden 硬截断 - 之前用 ::after fade-mask 会在内容不超 max-height 时把最后一段压白成白边 */
.ghost-md-preview {
  min-width: 160px;
  max-width: 320px;
  max-height: 140px;
  overflow: hidden;
  font-size: 0.75rem;
  line-height: 1.5;
}
/* 限制 ghost 内 vditor-reset 的字号 / 排版 (避免标题图片等占太大) */
.ghost-md-preview :deep(.vditor-reset) {
  font-size: 0.75rem;
}
.ghost-md-preview :deep(.vditor-reset p) {
  margin: 0.2em 0;
}
.ghost-md-preview :deep(.vditor-reset h1),
.ghost-md-preview :deep(.vditor-reset h2),
.ghost-md-preview :deep(.vditor-reset h3),
.ghost-md-preview :deep(.vditor-reset h4),
.ghost-md-preview :deep(.vditor-reset h5),
.ghost-md-preview :deep(.vditor-reset h6) {
  font-size: 0.85rem;
  margin: 0.3em 0;
}
.ghost-md-preview :deep(.vditor-reset img) {
  max-width: 100%;
  max-height: 60px;
  border-radius: 4px;
}
/* 多选拖动时多张卡片 HTML 用 hr.ghost-divider 串联 */
.ghost-md-preview :deep(.ghost-divider) {
  border: none;
  border-top: 1px dashed rgb(0 0 0 / 0.15);
  margin: 0.4em 0;
}

/* 多选 / 兜底文本预览 (保留换行 + 多行限制 3 行). 跟 NoteCard.text 计算保持 120 字截断一致 */
.ghost-text-preview {
  white-space: pre-line;
  word-break: break-word;
  overflow: hidden;
  max-height: 4.5em;
  line-height: 1.5;
}
</style>
