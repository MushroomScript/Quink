<script setup lang="ts">
// 文字颜色 / 字号的下拉面板。由 RichEditor 工具栏上的自定义按钮唤起。
//
// 交互仿 Word (蘑菇 2026-08-03 定):
//   工具栏按钮上有一条当前色的色条, 直接点按钮 = 套用当前色;
//   点按钮右侧小箭头 = 展开这个面板选别的色 / 清除样式。
// 面板定位走 unzoomRect (CSS zoom 下裸 rect 会偏, 见根 ZOOM.md)。
import { computed, ref, watch, nextTick } from 'vue';
import { unzoomRect, unzoomViewport } from '@/utils/zoom';

const props = defineProps<{
  open: boolean;
  /** 唤起它的那个工具栏按钮, 用来定位 */
  anchor?: HTMLElement | null;
  kind: 'color' | 'size';
  current?: string;
}>();

const emit = defineEmits<{
  (e: 'pick', value: string): void;
  (e: 'clear'): void;
  (e: 'close'): void;
}>();

// 预设色固定不跟随主题 (蘑菇 2026-08-03 定): 跟随的话用户选过的颜色会随主题变, 反而莫名其妙。
// 排成 8 列 x 5 行: 每列一个色系, 从浅到深 —— 比系统那个方方正正的取色器好挑也好看。
const HUES = [
  ['#f9fafb', '#d1d5db', '#6b7280', '#374151', '#111827'],  // 灰
  ['#fee2e2', '#fca5a5', '#ef4444', '#dc2626', '#7f1d1d'],  // 红
  ['#ffedd5', '#fdba74', '#f97316', '#ea580c', '#7c2d12'],  // 橙
  ['#fef3c7', '#fcd34d', '#f59e0b', '#d97706', '#78350f'],  // 黄
  ['#dcfce7', '#86efac', '#22c55e', '#16a34a', '#14532d'],  // 绿
  ['#cffafe', '#67e8f9', '#06b6d4', '#0891b2', '#164e63'],  // 青
  ['#dbeafe', '#93c5fd', '#3b82f6', '#2563eb', '#1e3a8a'],  // 蓝
  ['#f3e8ff', '#d8b4fe', '#a855f7', '#9333ea', '#581c87'],  // 紫
];

// hex 手输: 支持 #abc / #aabbcc, 回车应用
const hexInput = ref('');
function applyHex() {
  let v = hexInput.value.trim();
  if (!v.startsWith('#')) v = '#' + v;
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return;
  emit('pick', v.toLowerCase());
}
// 字号档位仿 Word 的下拉, 直接给数字。单位 px, 覆盖从小字注释到大标题
const SIZES = [12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 64];

/** 当前字号的纯数字 (没设过就是空) */
const currentNum = computed(() => {
  const n = parseInt(props.current || '', 10);
  return Number.isFinite(n) ? n : null;
});

// 自定义输入: 打开面板时同步成当前值。
// **不要自动 focus** —— 输入框一拿到焦点, 编辑器里的选区就没了, 后面套样式会因为"没选中文字"而失败。
// (调用方虽然存了选区能恢复, 但少一次焦点转移更稳, 而且大多数时候用户是点现成数字不是敲自定义)
const customInput = ref('');
const customRef = ref<HTMLInputElement | null>(null);
watch(() => props.open, (v) => {
  if (!v || props.kind !== 'size') return;
  customInput.value = currentNum.value ? String(currentNum.value) : '';
});

function applyCustom() {
  const n = parseInt(customInput.value, 10);
  // 夹一下范围: 太小看不见, 太大一个字撑爆整行
  if (!Number.isFinite(n) || n < 8 || n > 200) return;
  emit('pick', `${n}px`);
}

const panelStyle = computed(() => {
  if (!props.anchor) return { display: 'none' };
  const r = unzoomRect(props.anchor);
  const { vw } = unzoomViewport();
  const width = props.kind === 'color' ? 204 : 68;
  return {
    position: 'fixed' as const,
    top: `${r.bottom + 6}px`,
    left: `${Math.max(8, Math.min(r.left, vw - width - 8))}px`,
    zIndex: 'var(--z-overlay)',
  };
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="etsp-backdrop" @mousedown.prevent="emit('close')" />
    <!-- 注意: mousedown.prevent 只加在按钮上, 不能加在面板根节点 ——
         加在根上的话自定义字号那个 input 永远拿不到焦点, 打不了字。
         按钮加 prevent 是为了点它时不把焦点从编辑器抢走(选区还在, 才知道给谁上色)。 -->
    <div v-if="open" class="etsp" :class="`etsp-panel-${kind}`" :style="panelStyle">
      <template v-if="kind === 'color'">
        <div class="etsp-grid">
          <button v-for="c in HUES.flat()" :key="c" class="etsp-swatch" @mousedown.prevent
            :class="{ 'etsp-on': current === c }"
            :style="{ background: c }" :title="c"
            @click="emit('pick', c)" />
        </div>
        <input v-model="hexInput" class="etsp-hex" placeholder="#RRGGBB"
          spellcheck="false" @keydown.enter.prevent="applyHex" @keydown.stop />
      </template>

      <template v-else>
        <!-- 输入数字回车即应用, 不放确认按钮 (蘑菇 2026-08-03: 回车就行)。
             用 type=text 而不是 number: number 即使把 spinner 隐藏了, 浏览器仍会给它留出
             右侧的按钮空间, 导致文字和光标看起来都偏右、居中失效 (蘑菇实测反馈)。
             inputmode=numeric 保证手机上还是弹数字键盘。 -->
        <input ref="customRef" v-model="customInput" type="text" inputmode="numeric"
          class="etsp-num" placeholder="14" maxlength="3"
          @keydown.enter.prevent="applyCustom" @keydown.stop />
        <div class="etsp-sizes">
          <button v-for="s in SIZES" :key="s" class="etsp-size" @mousedown.prevent
            :class="{ 'etsp-on': currentNum === s }"
            @click="emit('pick', `${s}px`)">{{ s }}</button>
        </div>
      </template>

      <div class="etsp-foot">
        <button class="etsp-clear" @mousedown.prevent @click="emit('clear')">清除</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.etsp-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay-backdrop);
}
.etsp {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .14);
  padding: 8px;
  user-select: none;
}
/* 字号面板只放两位数 + 一个细滚动条, 别撑那么宽 (蘑菇 2026-08-03: "调的太宽了")。
   注意面板 class 要跟数字按钮的 .etsp-size 区分开, 不然宽度会套到每个按钮上 */
.etsp-panel-size { width: 68px; }
/* 8 个色系 x 5 档深浅, 纵向一列一个色系 */
.etsp-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  grid-auto-flow: column;
  grid-template-rows: repeat(5, 1fr);
  gap: 3px;
}
.etsp-swatch {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, .1);
  cursor: pointer;
  transition: transform .1s;
}
.etsp-swatch:hover { transform: scale(1.18); }
.etsp-swatch.etsp-on { box-shadow: 0 0 0 2px rgb(var(--c-accent)); }

/* 手输色值 / 字号, 都是回车应用, 不放确认按钮 */
.etsp-hex,
.etsp-num {
  width: 100%;
  margin-top: 8px;
  padding: 4px 7px;
  border: 1px solid #d1d5db;
  border-radius: 5px;
  font-size: 12px;
  color: #374151;
  outline: none;
  background: #fff;
}
/* 左对齐: 下面的数字列表因为有滚动条会整体偏左, 输入框再居中的话两边看着就不齐了
   (蘑菇 2026-08-03 反馈"字号那里偏"就是这个原因, 不是输入框自己的问题) */
.etsp-num {
  margin: 0 0 6px;
  text-align: left;
  font-variant-numeric: tabular-nums;
}
.etsp-hex:focus,
.etsp-num:focus { border-color: rgb(var(--c-accent)); }

/* 数字多, 给个滚动区免得面板顶到屏幕外。滚动条做细一点, 少占地方 */
.etsp-sizes {
  max-height: 208px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.etsp-sizes::-webkit-scrollbar { width: 4px; }
.etsp-sizes::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 2px; }
.etsp-sizes::-webkit-scrollbar-track { background: transparent; }
.etsp-size {
  display: block;
  width: 100%;
  padding: 4px 7px;
  border-radius: 5px;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  color: #374151;
  text-align: left;
  line-height: 1.4;
}
.etsp-size:hover { background: #f3f4f6; }
.etsp-size.etsp-on { background: rgb(var(--c-accent-light)); color: rgb(var(--c-accent-dark)); }

/* 清除按钮只占"清除"两个字的宽度, 不铺满整行 (蘑菇 2026-08-03) */
.etsp-foot {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid #f3f4f6;
  text-align: center;
}
.etsp-clear {
  padding: 3px 10px;
  border-radius: 5px;
  font-size: 12px;
  color: #6b7280;
}
.etsp-clear:hover { color: #ef4444; background: #fef2f2; }

[data-theme="dark"] .etsp {
  background: #262626;
  border-color: #3f3f46;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .4);
}
[data-theme="dark"] .etsp-size { color: #d4d4d8; }
[data-theme="dark"] .etsp-size:hover { background: #3f3f46; }
[data-theme="dark"] .etsp-hex,
[data-theme="dark"] .etsp-num {
  background: #1f1f22;
  border-color: #3f3f46;
  color: #e4e4e7;
}
[data-theme="dark"] .etsp-clear { color: #a1a1aa; }
[data-theme="dark"] .etsp-clear:hover { background: rgba(239, 68, 68, .15); }
[data-theme="dark"] .etsp-foot { border-top-color: #3f3f46; }
[data-theme="dark"] .etsp-sizes::-webkit-scrollbar-thumb { background: #52525b; }
</style>
