<script setup lang="ts">
// Vditor IR 编辑器的表格悬浮操作控件, 两块:
//   1. 表格浮动面板 —— 光标进表格时浮现在表格上方 (插行/插列/行上下移/列对齐/删行)
//   2. 表格右键菜单 —— 右键单元格弹出完整功能 (比面板多删列、整表上下移、删整表)
//
// 段落整块上下移**不在这里** —— 蘑菇 2026-08-03 定: 放 Vditor 工具栏, 不要悬浮箭头。
// 实现在 RichEditor.vue 的 toolbar 自定义按钮里, 同样调 utils/editorBlockOps.ts。
//
// 所有 DOM 操作都在 utils/editorBlockOps.ts, 这里只管 UI 跟定位。
// 定位一律 fixed + unzoomRect (CSS zoom 下裸 getBoundingClientRect 会偏, 见根 ZOOM.md)。
// 每个 RichEditor 实例挂一个本组件, 各自监听自己的 editorEl, 天然隔离不串。
import { ref, reactive, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { unzoomRect, unzoomViewport } from '@/utils/zoom';
import {
  findCell, findTable, findBlock, commit, focusCell,
  insertRowAbove, insertRowBelow, deleteRow, moveRowUp, moveRowDown,
  insertColumnLeft, insertColumnRight, deleteColumn,
  setColumnAlign, getColumnAlign, deleteTable,
  moveBlockUp, moveBlockDown, cellCoord, cellAt,
  type ColumnAlign,
} from '@/utils/editorBlockOps';
import {
  PhRowsPlusTop, PhRowsPlusBottom, PhColumnsPlusLeft, PhColumnsPlusRight,
  PhArrowUp, PhArrowDown, PhTrash, PhTable,
  PhTextAlignLeft, PhTextAlignCenter, PhTextAlignRight,
} from '@phosphor-icons/vue';

const props = defineProps<{
  editorEl?: HTMLElement | null;
  /** 改完 DOM 后调, 由 RichEditor 负责"标脏 + 记撤销栈"(见那边 afterBlockOp 的注释) */
  afterOp?: () => void;
}>();

// 当前光标锚定的单元格 / 块。所有操作都基于它们, 不重新查 selection
// (菜单点击时焦点已经跑到按钮上, 那时候再查 selection 就晚了)
let anchorCell: HTMLTableCellElement | null = null;
let anchorBlock: HTMLElement | null = null;

const bar = reactive({ visible: false, top: 0, left: 0, align: null as ColumnAlign | null });
const menu = reactive({ visible: false, top: 0, left: 0, align: null as ColumnAlign | null });

function root(): HTMLElement | null {
  return props.editorEl ?? null;
}

function hideAll() {
  bar.visible = false;
  menu.visible = false;
}

/** 光标变了就重新决定显示什么、显示在哪 */
function syncOverlays() {
  const el = root();
  if (!el) { hideAll(); return; }
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) { bar.visible = false; return; }
  const node = sel.getRangeAt(0).startContainer;
  if (!el.contains(node)) { bar.visible = false; return; }

  anchorCell = findCell(node);
  anchorBlock = findBlock(node, el);

  const { vw } = unzoomViewport();

  // 表格面板: 贴在表格上边缘外侧
  const table = anchorCell ? findTable(anchorCell) : null;
  if (table) {
    const r = unzoomRect(table);
    bar.visible = true;
    bar.top = Math.max(4, r.top - 34);
    bar.left = Math.min(Math.max(8, r.left), vw - 340);
    bar.align = anchorCell ? getColumnAlign(anchorCell) : null;
  } else {
    bar.visible = false;
  }
}

function onContextMenu(e: MouseEvent) {
  const el = root();
  if (!el) return;
  const cell = findCell(e.target as Node);
  if (!cell) return;                    // 不在表格里就走浏览器默认右键
  e.preventDefault();
  anchorCell = cell;
  anchorBlock = findBlock(cell, el);
  menu.align = getColumnAlign(cell);
  const { vw, vh } = unzoomViewport();
  const z = unzoomRect(new DOMRect(e.clientX, e.clientY, 0, 0));
  menu.left = Math.min(z.left, vw - 190);
  menu.top = Math.min(z.top, Math.max(4, vh - 400));
  menu.visible = true;
}

/**
 * 跑一个表格操作: 改 DOM -> 记下光标该落在哪(坐标) -> commit 让 Vditor 同步 markdown+撤销栈
 * -> 重建完成后按坐标把光标放回去 -> 重新定位控件。
 *
 * 为什么用坐标而不是元素引用: commit 会让 Vditor 重渲染整个 block, 表格 DOM 整个重建,
 * 操作前后拿到的单元格引用全部失效。拿失效引用设光标 = 把光标丢到 detached 节点上,
 * 实测 WYSIWYG 下会让光标飘走、接着整张表被序列化坏掉直接消失。
 * 坐标(第几行第几列)能跨重建存活, 是唯一可靠的锚。
 */
function run(fn: () => unknown, opts: { keepMenu?: boolean } = {}) {
  const el = root();
  if (!el || !anchorCell) return;

  // 表格所在的顶层块索引, commit 后靠它找回这张表
  const tableBlock = findBlock(anchorCell, el);
  const blockIdx = tableBlock ? Array.prototype.indexOf.call(el.children, tableBlock) : -1;

  const result = fn();
  // 光标目标: 操作返回了新单元格就用它, 否则留在原单元格
  const target = result instanceof HTMLElement ? result : (anchorCell.isConnected ? anchorCell : null);
  const coord = target ? cellCoord(target as HTMLTableCellElement) : null;

  commit(el);
  props.afterOp?.();
  if (!opts.keepMenu) menu.visible = false;

  nextTick(() => {
    if (coord && blockIdx >= 0) {
      const blk = el.children[blockIdx] as HTMLElement | undefined;
      const table = blk?.tagName === 'TABLE' ? blk as HTMLTableElement : blk?.querySelector?.('table') ?? null;
      const cell = table ? cellAt(table, coord) : null;
      if (cell) focusCell(cell);
    }
    syncOverlays();
  });
}

/**
 * 块上下移。移动后必须把光标跟着挪到那个块里, 否则连续点"上移"只有第一次生效
 * (光标还留在原位置, 第二次点时 anchorBlock 已经是别的块了)。
 * commit 可能让 Vditor 重建 DOM, 所以用"在编辑区里的第几个子元素"这个位置索引找回来。
 */
function runBlock(fn: (b: HTMLElement) => boolean) {
  const el = root();
  if (!el || !anchorBlock) return;
  const block = anchorBlock;
  if (!fn(block)) return;
  const idx = Array.prototype.indexOf.call(el.children, block);
  commit(el);
  props.afterOp?.();
  nextTick(() => {
    const moved = (idx >= 0 ? el.children[idx] : null) as HTMLElement | null;
    if (moved) focusCell(moved, true);
    syncOverlays();
  });
}

// 表格操作 (面板和菜单共用同一组)
const doRowAbove = () => run(() => insertRowAbove(anchorCell!));
const doRowBelow = () => run(() => insertRowBelow(anchorCell!));
const doRowDelete = () => run(() => deleteRow(anchorCell!));
const doRowUp = () => run(() => moveRowUp(anchorCell!));
const doRowDown = () => run(() => moveRowDown(anchorCell!));
const doColLeft = () => run(() => insertColumnLeft(anchorCell!));
const doColRight = () => run(() => insertColumnRight(anchorCell!));
const doColDelete = () => run(() => deleteColumn(anchorCell!));
const doAlign = (a: ColumnAlign) => run(() => {
  setColumnAlign(anchorCell!, a);
  menu.align = a; bar.align = a;
  return null;
});
const doDeleteTable = () => run(() => deleteTable(anchorCell!));
// 表格整体上下移: 表格本身就是一个块, 复用块移动
const doTableUp = () => runBlock(moveBlockUp);
const doTableDown = () => runBlock(moveBlockDown);

function onDocMouseDown(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (t.closest?.('.ebt-menu') || t.closest?.('.ebt-bar')) return;
  menu.visible = false;
}
function onSelectionChange() { syncOverlays(); }
function onScrollOrResize() { syncOverlays(); }

onMounted(() => {
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('mousedown', onDocMouseDown, true);
  window.addEventListener('resize', onScrollOrResize);
  // 编辑区自己滚动时也要跟 (Vditor 内容区是独立滚动容器), capture 才收得到
  document.addEventListener('scroll', onScrollOrResize, true);
  props.editorEl?.addEventListener('contextmenu', onContextMenu);
});

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', onSelectionChange);
  document.removeEventListener('mousedown', onDocMouseDown, true);
  window.removeEventListener('resize', onScrollOrResize);
  document.removeEventListener('scroll', onScrollOrResize, true);
  props.editorEl?.removeEventListener('contextmenu', onContextMenu);
});

defineExpose({ hideAll });
</script>

<template>
  <Teleport to="body">
    <!-- 表格浮动面板 -->
    <div v-if="bar.visible" class="ebt-bar" :style="{ top: bar.top + 'px', left: bar.left + 'px' }">
      <button @mousedown.prevent @click="doRowAbove" title="上方插入一行"><PhRowsPlusTop size="0.875rem" weight="fill" /></button>
      <button @mousedown.prevent @click="doRowBelow" title="下方插入一行"><PhRowsPlusBottom size="0.875rem" weight="fill" /></button>
      <button @mousedown.prevent @click="doColLeft" title="左边插入一列"><PhColumnsPlusLeft size="0.875rem" weight="fill" /></button>
      <button @mousedown.prevent @click="doColRight" title="右边插入一列"><PhColumnsPlusRight size="0.875rem" weight="fill" /></button>
      <span class="ebt-sep"></span>
      <button @mousedown.prevent @click="doRowUp" title="本行上移"><PhArrowUp size="0.875rem" weight="fill" /></button>
      <button @mousedown.prevent @click="doRowDown" title="本行下移"><PhArrowDown size="0.875rem" weight="fill" /></button>
      <span class="ebt-sep"></span>
      <button @mousedown.prevent @click="doAlign('left')" :class="{ 'ebt-on': bar.align === 'left' }" title="本列左对齐">
        <PhTextAlignLeft size="0.875rem" weight="fill" />
      </button>
      <button @mousedown.prevent @click="doAlign('center')" :class="{ 'ebt-on': bar.align === 'center' }" title="本列居中">
        <PhTextAlignCenter size="0.875rem" weight="fill" />
      </button>
      <button @mousedown.prevent @click="doAlign('right')" :class="{ 'ebt-on': bar.align === 'right' }" title="本列右对齐">
        <PhTextAlignRight size="0.875rem" weight="fill" />
      </button>
      <span class="ebt-sep"></span>
      <button @mousedown.prevent @click="doRowDelete" class="ebt-danger" title="删除本行">
        <PhTrash size="0.875rem" weight="fill" style="margin-top: 1px" />
      </button>
    </div>

    <!-- 表格右键菜单 -->
    <div v-if="menu.visible" class="ebt-menu" :style="{ top: menu.top + 'px', left: menu.left + 'px' }">
      <button @mousedown.prevent @click="doRowAbove"><PhRowsPlusTop size="0.875rem" weight="fill" />上方插入一行</button>
      <button @mousedown.prevent @click="doRowBelow"><PhRowsPlusBottom size="0.875rem" weight="fill" />下方插入一行</button>
      <button @mousedown.prevent @click="doRowUp"><PhArrowUp size="0.875rem" weight="fill" />本行上移</button>
      <button @mousedown.prevent @click="doRowDown"><PhArrowDown size="0.875rem" weight="fill" />本行下移</button>
      <button @mousedown.prevent @click="doRowDelete" class="ebt-danger"><PhTrash size="0.875rem" weight="fill" />删除本行</button>
      <hr />
      <button @mousedown.prevent @click="doColLeft"><PhColumnsPlusLeft size="0.875rem" weight="fill" />左边插入一列</button>
      <button @mousedown.prevent @click="doColRight"><PhColumnsPlusRight size="0.875rem" weight="fill" />右边插入一列</button>
      <button @mousedown.prevent @click="doColDelete" class="ebt-danger"><PhTrash size="0.875rem" weight="fill" />删除本列</button>
      <hr />
      <button @mousedown.prevent @click="doAlign('left')" :class="{ 'ebt-on': menu.align === 'left' }"><PhTextAlignLeft size="0.875rem" weight="fill" />本列左对齐</button>
      <button @mousedown.prevent @click="doAlign('center')" :class="{ 'ebt-on': menu.align === 'center' }"><PhTextAlignCenter size="0.875rem" weight="fill" />本列居中</button>
      <button @mousedown.prevent @click="doAlign('right')" :class="{ 'ebt-on': menu.align === 'right' }"><PhTextAlignRight size="0.875rem" weight="fill" />本列右对齐</button>
      <hr />
      <button @mousedown.prevent @click="doTableUp"><PhArrowUp size="0.875rem" weight="fill" />整个表格上移</button>
      <button @mousedown.prevent @click="doTableDown"><PhArrowDown size="0.875rem" weight="fill" />整个表格下移</button>
      <button @mousedown.prevent @click="doDeleteTable" class="ebt-danger"><PhTable size="0.875rem" weight="fill" />删除整个表格</button>
    </div>
  </Teleport>
</template>

<style scoped>
/* position: fixed 是必须的 —— 少了它 inline 的 top/left 不起作用,
   Teleport 到 body 的面板会按文档流掉到页面最底部 */
.ebt-bar,
.ebt-menu {
  position: fixed;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .12);
  user-select: none;
}

.ebt-bar {
  z-index: var(--z-overlay);
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 3px 4px;
}
.ebt-bar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  color: #6b7280;
  transition: background-color .12s, color .12s;
}
.ebt-bar button:hover { background: #f3f4f6; color: #374151; }
.ebt-sep { width: 1px; height: 14px; background: #e5e7eb; margin: 0 2px; }

.ebt-menu {
  z-index: var(--z-context-menu);
  min-width: 172px;
  padding: 4px;
}
.ebt-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  border-radius: 5px;
  font-size: 13px;
  color: #374151;
  text-align: left;
  transition: background-color .12s;
}
.ebt-menu button:hover { background: #f3f4f6; }
.ebt-menu hr { border: none; border-top: 1px solid #f3f4f6; margin: 4px 0; }
/* 当前列已选的对齐方式高亮, 面板和菜单共用 */
.ebt-on { background: rgb(var(--c-accent-light)) !important; color: rgb(var(--c-accent-dark)) !important; }

.ebt-danger { color: #ef4444 !important; }
.ebt-danger:hover { background: #fef2f2 !important; }

/* 暗色主题。写法跟 ReactionBar / CommentThread 一致: scoped style 里直接写
   [data-theme="dark"] 前缀即可 (祖先选择器不带 scoped 属性, 最后一段才带, 照样匹配)。
   不要用 :global(...) 包 —— 实测那样编译不出规则, 暗色完全不生效。 */
[data-theme="dark"] .ebt-bar,
[data-theme="dark"] .ebt-menu {
  background: #262626;
  border-color: #3f3f46;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .4);
}
[data-theme="dark"] .ebt-bar button,
[data-theme="dark"] .ebt-menu button { color: #d4d4d8; }
[data-theme="dark"] .ebt-bar button:hover,
[data-theme="dark"] .ebt-menu button:hover { background: #3f3f46; color: #f4f4f5; }
[data-theme="dark"] .ebt-sep { background: #3f3f46; }
[data-theme="dark"] .ebt-menu hr { border-top-color: #3f3f46; }
[data-theme="dark"] .ebt-danger:hover { background: rgba(239, 68, 68, .15) !important; }
</style>
