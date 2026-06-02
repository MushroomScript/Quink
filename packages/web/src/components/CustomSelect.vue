<script setup lang="ts">
/**
 * CustomSelect —— 仿 native <select> 接口的自定义下拉。
 *
 * 起因：Win11 Electron 下 native <select> 的下拉 popup 是 OS 级控件，
 *   CSS color-scheme: dark 控制不了 popup 内部背景/滚动条 → dark 主题下
 *   仍显示白底白滚动条。同根因 DatePicker.vue 时分下拉已经改成自定义按钮列绕过。
 *
 * 用法：
 *   <CustomSelect v-model="val" :options="[{ value, label, disabled? }]" />
 *   <CustomSelect v-model="val" :options="opts" size="sm" class="w-48" />
 *
 * 接口仿 native：
 *   - v-model 双绑 value（string | number）
 *   - @change 选中变化时触发（对齐 native <select>）
 *   - placeholder：modelValue 不在 options 中时显示
 *   - disabled：整体禁用
 *   - size：md（默认 py-2 text-sm）/ compact（py-1.5 text-sm）/ sm（py-1.5 text-xs）
 *   - maxHeight：popup 最大高度（超出滚动），默认 240
 *
 * 实现要点：
 *   - trigger 是单根 button，外层 class 自动合并到 trigger（透传宽度等布局类）
 *   - popup 用 Teleport 到 body，绕开父级 overflow: hidden / transform
 *   - fixed 定位 + getBoundingClientRect 算位置，下方空间够就下方否则上方
 *   - 滚动 / resize 时关闭 popup（不重定位，简化）
 *   - 滚动条走 scoped CSS（dark 主题适配在底部）
 *   - 键盘：Enter/Space/Arrow 打开，Arrow 移动 active，Enter 选中，Esc 关闭
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';

// 组件 template 是多根（button + Teleport），Vue 默认不会把外层传入的 class/style
// 透传到任一节点，需要显式 v-bind="$attrs" 落到 trigger button 上。
defineOptions({ inheritAttrs: false });

interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

const props = withDefaults(defineProps<{
  modelValue: string | number | undefined | null;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  size?: 'md' | 'compact' | 'sm';
  maxHeight?: number;
}>(), {
  placeholder: '请选择',
  disabled: false,
  size: 'md',
  maxHeight: 240,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | number): void;
  (e: 'change', value: string | number): void;
}>();

const open = ref(false);
const triggerEl = ref<HTMLButtonElement | null>(null);
const popupEl = ref<HTMLDivElement | null>(null);
const popupStyle = ref<Record<string, string>>({});
// 键盘导航 active 项 index，-1 表示无。鼠标 hover 时也会同步到这。
const activeIndex = ref(-1);

const selectedOption = computed(() =>
  props.options.find(o => o.value === props.modelValue)
);
const displayLabel = computed(() => selectedOption.value?.label ?? props.placeholder);
const isPlaceholder = computed(() => !selectedOption.value);

function togglePopup() {
  if (props.disabled) return;
  open.value ? closePopup() : openPopup();
}

function openPopup() {
  if (props.disabled) return;
  open.value = true;
  activeIndex.value = props.options.findIndex(o => o.value === props.modelValue);
  nextTick(() => {
    positionPopup();
    scrollActiveIntoView();
  });
}

function closePopup() {
  open.value = false;
  activeIndex.value = -1;
}

function positionPopup() {
  if (!triggerEl.value) return;
  const rect = triggerEl.value.getBoundingClientRect();
  // popup 高度估算：item 行高约 30px + 内 padding 8px，取 maxHeight 上限
  const estHeight = Math.min(props.maxHeight, props.options.length * 30 + 8);
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow >= estHeight + 8
    ? rect.bottom + 4
    : Math.max(8, rect.top - estHeight - 4);
  popupStyle.value = {
    top: `${top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    maxHeight: `${props.maxHeight}px`,
  };
}

function scrollActiveIntoView() {
  if (activeIndex.value < 0 || !popupEl.value) return;
  const items = popupEl.value.querySelectorAll('.qsel-item');
  const active = items[activeIndex.value] as HTMLElement | undefined;
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function selectOption(opt: SelectOption) {
  if (opt.disabled) return;
  emit('update:modelValue', opt.value);
  emit('change', opt.value);
  closePopup();
  // popup 关闭后还 focus 回 trigger，让键盘焦点不丢
  nextTick(() => triggerEl.value?.focus());
}

function onDocPointerDown(e: MouseEvent) {
  if (!open.value) return;
  const t = e.target as Node;
  if (triggerEl.value?.contains(t)) return;
  if (popupEl.value?.contains(t)) return;
  closePopup();
}

// 滚动 / resize 时直接关掉 popup，不重定位（用户重新打开会拿到新位置）
function onWindowChange() {
  if (open.value) closePopup();
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return;
  if (!open.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openPopup();
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closePopup();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const opt = props.options[activeIndex.value];
    if (opt) selectOption(opt);
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveActive(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveActive(-1);
  }
}

// 跳过 disabled 项移动 active，n 次都没找到就放弃（全 disabled 场景）
function moveActive(step: number) {
  const n = props.options.length;
  if (n === 0) return;
  let i = activeIndex.value;
  for (let count = 0; count < n; count++) {
    i = (i + step + n) % n;
    if (!props.options[i].disabled) {
      activeIndex.value = i;
      nextTick(() => scrollActiveIntoView());
      return;
    }
  }
}

// 外部 modelValue 变化（如父组件重置）时同步 active 高亮
watch(() => props.modelValue, () => {
  if (open.value) {
    activeIndex.value = props.options.findIndex(o => o.value === props.modelValue);
  }
});

onMounted(() => {
  document.addEventListener('mousedown', onDocPointerDown);
  window.addEventListener('resize', onWindowChange);
  // capture: true 才能收到子级 scroll（scroll 事件不冒泡）
  window.addEventListener('scroll', onWindowChange, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocPointerDown);
  window.removeEventListener('resize', onWindowChange);
  window.removeEventListener('scroll', onWindowChange, true);
});
</script>

<template>
  <button
    ref="triggerEl"
    type="button"
    class="qsel-trigger"
    :class="[
      `qsel-trigger--${size}`,
      { 'qsel-open': open, 'qsel-placeholder': isPlaceholder },
      $attrs.class,
    ]"
    :disabled="disabled"
    @click="togglePopup"
    @keydown="onKeydown"
  >
    <span class="qsel-label">{{ displayLabel }}</span>
    <svg class="qsel-arrow" :class="{ 'qsel-arrow--up': open }" viewBox="0 0 12 8" fill="none" aria-hidden="true">
      <path d="M1 1.5 L6 6.5 L11 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  <Teleport to="body">
    <div v-if="open" ref="popupEl" class="qsel-popup" :style="popupStyle">
      <button v-for="(opt, i) in options" :key="String(opt.value)"
        type="button"
        class="qsel-item"
        :class="{
          'qsel-item--active': activeIndex === i,
          'qsel-item--selected': modelValue === opt.value,
          'qsel-item--disabled': opt.disabled,
        }"
        :disabled="opt.disabled"
        @mouseenter="!opt.disabled && (activeIndex = i)"
        @click="selectOption(opt)"
      >{{ opt.label }}</button>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Trigger ── */
.qsel-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  /* width 不写, 跟 native select 一致, 由外层 class (如 w-full / w-48) 控制 */
  background: white;
  color: rgb(55 65 81);  /* gray-700 */
  border: 1px solid rgb(229 231 235);  /* gray-200 */
  border-radius: 8px;
  font-family: inherit;
  text-align: left;
  outline: none;
  cursor: var(--cur-pointer), pointer;
  transition: border-color 0.15s ease;
}
.qsel-trigger--md      { padding: 8px 12px;   font-size: 14px; }
.qsel-trigger--compact { padding: 6px 12px;   font-size: 14px; }
.qsel-trigger--sm      { padding: 6px 8px;    font-size: 12px; }

.qsel-trigger:hover:not(:disabled) { border-color: rgb(var(--c-accent-light)); }
.qsel-trigger:focus-visible { border-color: rgb(var(--c-accent)); }
.qsel-trigger.qsel-open { border-color: rgb(var(--c-accent)); }
.qsel-trigger:disabled { opacity: 0.5; cursor: var(--cur-not-allowed), not-allowed; }

.qsel-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qsel-placeholder .qsel-label { color: rgb(156 163 175); }  /* gray-400 */

.qsel-arrow {
  width: 10px;
  height: 8px;
  color: rgb(156 163 175);
  flex-shrink: 0;
  transition: transform 0.2s ease;
}
.qsel-arrow--up { transform: rotate(180deg); }

/* ── Popup ── */
.qsel-popup {
  position: fixed;
  /* 高于一般 modal (z-200 如 ReminderPicker), 低于全局 toast (z-9999), 详见根 Z-INDEX-SCALE.md */
  z-index: var(--z-popup);
  background: white;
  border: 1px solid rgb(229 231 235);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.qsel-popup::-webkit-scrollbar { width: 6px; }
.qsel-popup::-webkit-scrollbar-track { background: transparent; }
.qsel-popup::-webkit-scrollbar-thumb {
  background: rgb(0 0 0 / 0.15);
  border-radius: 3px;
}
.qsel-popup::-webkit-scrollbar-thumb:hover { background: rgb(0 0 0 / 0.25); }

.qsel-item {
  padding: 7px 10px;
  font-size: 13px;
  border-radius: 4px;
  background: transparent;
  color: rgb(55 65 81);
  border: none;
  cursor: var(--cur-pointer), pointer;
  font-family: inherit;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}
.qsel-item--active:not(.qsel-item--disabled):not(.qsel-item--selected) {
  background: rgb(var(--c-accent-light));
  color: rgb(var(--c-accent-dark));
}
.qsel-item--selected { background: rgb(var(--c-accent)); color: white; font-weight: 600; }
.qsel-item--disabled { opacity: 0.4; cursor: var(--cur-not-allowed), not-allowed; }

/* ── Dark theme ── */
[data-theme="dark"] .qsel-trigger {
  background: rgb(var(--c-sidebar-light));
  border-color: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.88);
}
[data-theme="dark"] .qsel-trigger:hover:not(:disabled) { border-color: rgba(var(--c-accent) / 0.5); }
[data-theme="dark"] .qsel-trigger.qsel-open,
[data-theme="dark"] .qsel-trigger:focus-visible { border-color: rgb(var(--c-accent)); }
[data-theme="dark"] .qsel-placeholder .qsel-label { color: rgba(255, 255, 255, 0.35); }
[data-theme="dark"] .qsel-arrow { color: rgba(255, 255, 255, 0.5); }

[data-theme="dark"] .qsel-popup {
  background: rgb(var(--c-sidebar));
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.4);
}
[data-theme="dark"] .qsel-popup::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.18); }
[data-theme="dark"] .qsel-popup::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.28); }

[data-theme="dark"] .qsel-item { color: rgba(255, 255, 255, 0.85); }
[data-theme="dark"] .qsel-item--active:not(.qsel-item--disabled):not(.qsel-item--selected) {
  background: rgba(var(--c-accent) / 0.18);
  color: rgba(255, 255, 255, 0.95);
}
[data-theme="dark"] .qsel-item--selected { background: rgb(var(--c-accent)); color: white; }
</style>
