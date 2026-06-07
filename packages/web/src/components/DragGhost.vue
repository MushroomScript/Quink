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

// 多选 ghost: 中心 = 鼠标位置 + 相对中心偏移. transform translate(-50%, -50%) 让 ghost 中心对齐 left/top.
// 注: mouseX/mouseY 必须当参数传入 (而非函数内读 dragState.ghostX/Y), 否则 Vue 模板内 :style 不会 track 跨函数 reactive 依赖 → 鼠标移动时 style 不更新
function multiGhostStyle(g: { relCenterX: number; relCenterY: number }, mouseX: number, mouseY: number) {
  const z = getCssZoom();
  return {
    left: ((mouseX + g.relCenterX) / z) + 'px',
    top: ((mouseY + g.relCenterY) / z) + 'px',
    transform: 'translate(-50%, -50%)',
  };
}

// Vditor.md2html 输出的 HTML 元素之间带 \n text node (例如 `<p>1</p>\n<br>\n<p>2</p>\n`).
// 这些 \n 在 ghost 内 inline context 形成 anonymous inline box, BR 周围会额外拉高 line-height (~18px) → 视觉看像多了一行白边.
// 1) 清理元素之间的纯空白 text node (>\s+<  → ><) 让 layout 紧凑
// 2) 剥末尾 \n / \s / <br> 防末尾形成空白行
const ghostHtmlClean = computed(() => cleanHtmlStr(dragState.ghostHtml || ''));

// 共享给多选 ghost 用: 跟 ghostHtmlClean 同款 (清元素间 \n + 末尾 \n/br) 避免白边
function cleanHtmlStr(h: string) {
  if (!h) return '';
  let s = h.replace(/>\s+</g, '><');
  s = s.replace(/(\s|<br\s*\/?>)+$/i, '');
  return s;
}
</script>

<template>
  <Teleport to="body">
    <!-- 多选: ghosts 几何中心 = 鼠标位置, 各 ghost 按原始相对中心偏移摆放. 复用单选 ghost-md-preview 同款紧凑样式 (白底 + border + shadow + 小字号) -->
    <template v-if="dragState.active && dragState.ghosts.length > 0">
      <div v-for="g in dragState.ghosts" :key="g.id"
        class="pointer-events-none fixed z-[var(--z-overlay)] bg-white border border-gray-300 rounded-lg shadow-lg px-3 py-1.5 opacity-90 ghost-md-preview"
        :style="multiGhostStyle(g, dragState.ghostX, dragState.ghostY)">
        <div class="vditor-reset" v-html="cleanHtmlStr(g.html)" />
      </div>
    </template>
    <!-- 单选 / 兜底文本: 一个 ghost 紧跟鼠标 -->
    <div v-else-if="dragState.active"
      class="pointer-events-none fixed z-[var(--z-overlay)]"
      :style="ghostStyle">
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
/* 多选拖动时多张卡片 HTML 用 hr.ghost-divider 串联 (单选 ghost 内不会出现, 留着兼容) */
.ghost-md-preview :deep(.ghost-divider) {
  border: none;
  border-top: 1px dashed rgb(0 0 0 / 0.15);
  margin: 0.4em 0;
}

/* 多选 ghost 复用 .ghost-md-preview 紧凑样式 (跟单选 ghost 一致). 不需要单独 CSS. */

/* 多选 / 兜底文本预览 (保留换行 + 多行限制 3 行). 跟 NoteCard.text 计算保持 120 字截断一致 */
.ghost-text-preview {
  white-space: pre-line;
  word-break: break-word;
  overflow: hidden;
  max-height: 4.5em;
  line-height: 1.5;
}
</style>
