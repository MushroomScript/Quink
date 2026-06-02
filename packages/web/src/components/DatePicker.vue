<script setup lang="ts">
/**
 * Quink 风日期/日期时间选择器。
 *
 * 替换 native <input type="date" | "datetime-local">，所以原生日历悬浮窗
 * UA shadow DOM 不可控的视觉问题（cursor / 颜色 / 暗色不适配）全部解决。
 *
 * 用法：
 *   <DatePicker v-model="value" />                  // date, "YYYY-MM-DD"
 *   <DatePicker v-model="value" type="datetime" />  // datetime, "YYYY-MM-DDTHH:mm"
 *   <DatePicker v-model="value" :min="..." :max="..." placeholder="开始日" />
 *
 * 时分用两个 <select>（hh / mm），跟现有 Quink 下拉风格一致。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import dayjs, { type Dayjs } from 'dayjs';

const props = withDefaults(defineProps<{
  modelValue: string;
  type?: 'date' | 'datetime';
  min?: string;
  max?: string;
  placeholder?: string;
  disabled?: boolean;
}>(), {
  type: 'date'
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const isDateTime = computed(() => props.type === 'datetime');

// ─── 触发按钮显示文案 ───
const displayText = computed(() => {
  if (!props.modelValue) return props.placeholder || (isDateTime.value ? '选择日期时间' : '选择日期');
  const d = dayjs(props.modelValue);
  if (!d.isValid()) return props.placeholder || '';
  return d.format(isDateTime.value ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD');
});

// ─── 弹层状态 + 定位 ───
const open = ref(false);
const triggerEl = ref<HTMLButtonElement | null>(null);
const popupStyle = ref<Record<string, string>>({});

function openPicker() {
  if (props.disabled) return;
  // 同步当前 viewMonth 到 modelValue 所在月
  viewMonth.value = props.modelValue && dayjs(props.modelValue).isValid()
    ? dayjs(props.modelValue).startOf('month')
    : dayjs().startOf('month');
  open.value = true;
  nextTick(() => positionPopup());
}

function positionPopup() {
  if (!triggerEl.value) return;
  const rect = triggerEl.value.getBoundingClientRect();
  const popupWidth = isDateTime.value ? 320 : 288;
  const popupHeight = isDateTime.value ? 380 : 330;
  // 下方空间够就下方，否则上方
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow >= popupHeight + 8
    ? rect.bottom + 4
    : Math.max(8, rect.top - popupHeight - 4);
  // 左边对齐触发器，但不超出视口右侧
  const left = Math.min(rect.left, window.innerWidth - popupWidth - 8);
  popupStyle.value = {
    top: `${top}px`,
    left: `${Math.max(8, left)}px`,
    width: `${popupWidth}px`
  };
}

// ─── 月历状态 ───
const viewMonth = ref(dayjs().startOf('month'));
const today = computed(() => dayjs()); // computed 避免缓存跨日期

// 6 × 7 = 42 个连续日，周一始
const calendarDays = computed<Dayjs[]>(() => {
  // dayjs.day(): 0=Sun, 1=Mon ... 6=Sat
  const firstDay = viewMonth.value.day();
  const offset = (firstDay + 6) % 7; // Sun→6, Mon→0
  const start = viewMonth.value.subtract(offset, 'day');
  return Array.from({ length: 42 }, (_, i) => start.add(i, 'day'));
});

const selected = computed<Dayjs | null>(() => {
  if (!props.modelValue) return null;
  const d = dayjs(props.modelValue);
  return d.isValid() ? d : null;
});

function isSameDay(a: Dayjs, b: Dayjs | null) {
  return b ? a.format('YYYY-MM-DD') === b.format('YYYY-MM-DD') : false;
}
function isOtherMonth(d: Dayjs) {
  return d.month() !== viewMonth.value.month();
}
function isDisabled(d: Dayjs) {
  if (props.min && d.isBefore(dayjs(props.min), 'day')) return true;
  if (props.max && d.isAfter(dayjs(props.max), 'day')) return true;
  return false;
}

// ─── 时间状态（datetime）───
const hour = ref('00');
const minute = ref('00');

watch(() => props.modelValue, (v) => {
  if (v && isDateTime.value) {
    const d = dayjs(v);
    if (d.isValid()) {
      hour.value = d.format('HH');
      minute.value = d.format('mm');
    }
  }
}, { immediate: true });

const hourOptions = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0'));
const minuteOptions = Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, '0'));

// ─── 操作 ───
function selectDay(d: Dayjs) {
  if (isDisabled(d)) return;
  if (isDateTime.value) {
    // datetime: 选了日期不关弹层，让用户继续调时间
    emit('update:modelValue', `${d.format('YYYY-MM-DD')}T${hour.value}:${minute.value}`);
  } else {
    emit('update:modelValue', d.format('YYYY-MM-DD'));
    open.value = false;
  }
}

function onTimeChange() {
  const dayPart = selected.value
    ? selected.value.format('YYYY-MM-DD')
    : dayjs().format('YYYY-MM-DD');
  emit('update:modelValue', `${dayPart}T${hour.value}:${minute.value}`);
}

function selectToday() {
  const now = dayjs();
  if (isDateTime.value) {
    hour.value = now.format('HH');
    minute.value = now.format('mm');
    emit('update:modelValue', now.format('YYYY-MM-DDTHH:mm'));
  } else {
    emit('update:modelValue', now.format('YYYY-MM-DD'));
    open.value = false;
  }
  viewMonth.value = now.startOf('month');
}

function clear() {
  emit('update:modelValue', '');
  open.value = false;
}

function prevMonth() { viewMonth.value = viewMonth.value.subtract(1, 'month'); }
function nextMonth() { viewMonth.value = viewMonth.value.add(1, 'month'); }
function prevYear()  { viewMonth.value = viewMonth.value.subtract(1, 'year');  }
function nextYear()  { viewMonth.value = viewMonth.value.add(1, 'year');       }

// picker 关闭时一并复位时分弹层（不然下次打开 picker 看到时分弹层残留）
watch(open, (v) => {
  if (!v) {
    hourOpen.value = false;
    minuteOpen.value = false;
  }
});

// resize / scroll 时重定位（popup 是 fixed，触发器移动需要跟随）
function onWindowChange() { if (open.value) positionPopup(); }
function onEscape(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (hourOpen.value || minuteOpen.value) {
      hourOpen.value = false;
      minuteOpen.value = false;
    } else {
      open.value = false;
    }
  }
}

// 自定义时分下拉（native <select> 在 Win11 Electron 上 dropdown 是 OS 控件，
// CSS color-scheme 影响有限，dark 模式下展开 list 仍是白底。改成 button + 竖向滚动列）
const hourOpen = ref(false);
const minuteOpen = ref(false);
const hourListEl = ref<HTMLElement | null>(null);
const minuteListEl = ref<HTMLElement | null>(null);

function scrollActiveIntoView(listEl: HTMLElement | null) {
  if (!listEl) return;
  const active = listEl.querySelector('.qdp-titem.active') as HTMLElement | null;
  if (active) active.scrollIntoView({ block: 'center' });
}

function openHour() {
  minuteOpen.value = false;
  hourOpen.value = !hourOpen.value;
  if (hourOpen.value) nextTick(() => scrollActiveIntoView(hourListEl.value));
}
function openMinute() {
  hourOpen.value = false;
  minuteOpen.value = !minuteOpen.value;
  if (minuteOpen.value) nextTick(() => scrollActiveIntoView(minuteListEl.value));
}
function selectHour(h: string) {
  hour.value = h;
  hourOpen.value = false;
  onTimeChange();
}
function selectMinute(m: string) {
  minute.value = m;
  minuteOpen.value = false;
  onTimeChange();
}

onMounted(() => {
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('scroll', onWindowChange, true);
  document.addEventListener('keydown', onEscape);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowChange);
  window.removeEventListener('scroll', onWindowChange, true);
  document.removeEventListener('keydown', onEscape);
});
</script>

<template>
  <button
    ref="triggerEl"
    type="button"
    class="qdp-trigger"
    :class="{ 'is-empty': !modelValue, 'is-disabled': disabled }"
    :disabled="disabled"
    @click="openPicker"
  >
    <span>{{ displayText }}</span>
    <svg class="qdp-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path d="M7 4v3M17 4v3M3 10h18M5 6h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"
            stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>
    </svg>
  </button>

  <Teleport to="body">
    <template v-if="open">
      <div class="qdp-backdrop" @click="open = false" />
      <div class="qdp-popup" :style="popupStyle">
        <!-- 月份切换 -->
        <div class="qdp-header">
          <button type="button" class="qdp-nav" title="上一年" @click="prevYear">«</button>
          <button type="button" class="qdp-nav" title="上一月" @click="prevMonth">‹</button>
          <span class="qdp-title">{{ viewMonth.format('YYYY 年 M 月') }}</span>
          <button type="button" class="qdp-nav" title="下一月" @click="nextMonth">›</button>
          <button type="button" class="qdp-nav" title="下一年" @click="nextYear">»</button>
        </div>

        <!-- 周名 -->
        <div class="qdp-weekdays">
          <div>一</div><div>二</div><div>三</div><div>四</div><div>五</div><div>六</div><div>日</div>
        </div>

        <!-- 日期网格 -->
        <div class="qdp-grid">
          <button
            v-for="(d, i) in calendarDays"
            :key="i"
            type="button"
            class="qdp-cell"
            :class="{
              'is-other': isOtherMonth(d),
              'is-today': isSameDay(d, today),
              'is-selected': isSameDay(d, selected),
              'is-disabled': isDisabled(d)
            }"
            :disabled="isDisabled(d)"
            @click="selectDay(d)"
          >{{ d.date() }}</button>
        </div>

        <!-- 时间（仅 datetime）：自定义下拉，竖向单列滚动，向上展开 -->
        <div v-if="isDateTime" class="qdp-time">
          <span class="qdp-time-label">时间</span>
          <div class="qdp-tdrop">
            <button type="button" class="qdp-tbtn" :class="{ open: hourOpen }" @click="openHour">{{ hour }}</button>
            <div v-if="hourOpen" ref="hourListEl" class="qdp-tlist">
              <button v-for="h in hourOptions" :key="h"
                type="button"
                class="qdp-titem"
                :class="{ active: hour === h }"
                @click="selectHour(h)">{{ h }}</button>
            </div>
          </div>
          <span class="qdp-time-colon">:</span>
          <div class="qdp-tdrop">
            <button type="button" class="qdp-tbtn" :class="{ open: minuteOpen }" @click="openMinute">{{ minute }}</button>
            <div v-if="minuteOpen" ref="minuteListEl" class="qdp-tlist">
              <button v-for="m in minuteOptions" :key="m"
                type="button"
                class="qdp-titem"
                :class="{ active: minute === m }"
                @click="selectMinute(m)">{{ m }}</button>
            </div>
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="qdp-actions">
          <button type="button" class="qdp-btn-primary" @click="selectToday">今天</button>
          <button type="button" class="qdp-btn-ghost" @click="clear">清空</button>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
/* ─── 触发按钮 ─── */
.qdp-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: #374151;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
  transition: border-color 0.15s;
  font-family: inherit;
}
.qdp-trigger:hover:not(.is-disabled) {
  border-color: rgb(var(--c-accent) / 0.5);
}
.qdp-trigger:focus {
  outline: none;
  border-color: rgb(var(--c-accent));
}
.qdp-trigger.is-empty {
  color: #9ca3af;
}
.qdp-trigger.is-disabled {
  opacity: 0.5;
  cursor: var(--cur-not-allowed), not-allowed;
}
.qdp-icon {
  flex-shrink: 0;
  color: #9ca3af;
}
.qdp-trigger:hover:not(.is-disabled) .qdp-icon {
  color: rgb(var(--c-accent));
}

/* ─── Backdrop + Popup ─── */
.qdp-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-datepicker-backdrop);
}
.qdp-popup {
  position: fixed;
  z-index: var(--z-modal-media);
  background: white;
  border-radius: 12px;
  border: 1px solid rgb(0 0 0 / 0.06);
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.15);
  padding: 12px;
}

/* ─── Header ─── */
.qdp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  margin-bottom: 8px;
  padding: 0 2px;
}
.qdp-nav {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: #6b7280;
  font-size: 14px;
  background: transparent;
  border: none;
  font-family: inherit;
}
.qdp-nav:hover {
  background: rgb(var(--c-accent-light));
  color: rgb(var(--c-accent-dark));
}
.qdp-title {
  flex: 1;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  color: #374151;
  font-variant-numeric: tabular-nums;
}

/* ─── Weekdays ─── */
.qdp-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  margin-bottom: 4px;
  font-size: 11px;
  color: #9ca3af;
  text-align: center;
}
.qdp-weekdays > div {
  padding: 4px 0;
}

/* ─── Date grid ─── */
.qdp-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.qdp-cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 13px;
  color: #374151;
  background: transparent;
  border: none;
  transition: background 0.12s, color 0.12s;
  font-variant-numeric: tabular-nums;
  font-family: inherit;
}
.qdp-cell:hover:not(.is-disabled):not(.is-selected) {
  background: rgb(var(--c-accent-light));
}
.qdp-cell.is-other {
  color: #d1d5db;
}
.qdp-cell.is-today {
  font-weight: 700;
  box-shadow: inset 0 0 0 1px rgb(var(--c-accent));
  color: rgb(var(--c-accent-dark));
}
.qdp-cell.is-selected {
  background: rgb(var(--c-accent));
  color: white;
  font-weight: 600;
  box-shadow: none;
}
.qdp-cell.is-disabled {
  opacity: 0.3;
  cursor: var(--cur-not-allowed), not-allowed;
}

/* ─── Time ─── */
.qdp-time {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #f3f4f6;
  display: flex;
  align-items: center;
  gap: 6px;
}
.qdp-time-label {
  font-size: 12px;
  color: #6b7280;
  margin-right: 4px;
}
/* 自定义时分下拉 */
.qdp-tdrop {
  position: relative;  /* 弹层 anchor */
}
.qdp-tbtn {
  padding: 3px 10px;
  font-size: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  background: white;
  color: #374151;
  cursor: var(--cur-pointer), pointer;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  min-width: 44px;
}
.qdp-tbtn:hover { border-color: rgb(var(--c-accent) / 0.5); }
.qdp-tbtn.open { border-color: rgb(var(--c-accent)); }

/* 弹层：竖向单列滚动，向上展开，居中按钮 */
.qdp-tlist {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 2;
  width: 56px;
  max-height: 180px;
  overflow-y: auto;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 2px;
  box-shadow: 0 -6px 20px rgb(0 0 0 / 0.15);
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* 自定义滚动条让暗色主题协调 */
.qdp-tlist::-webkit-scrollbar { width: 5px; }
.qdp-tlist::-webkit-scrollbar-track { background: transparent; }
.qdp-tlist::-webkit-scrollbar-thumb {
  background: rgb(0 0 0 / 0.15);
  border-radius: 3px;
}
.qdp-tlist::-webkit-scrollbar-thumb:hover { background: rgb(0 0 0 / 0.25); }

.qdp-titem {
  padding: 5px 8px;
  font-size: 12px;
  border-radius: 4px;
  background: transparent;
  color: #374151;
  border: none;
  cursor: var(--cur-pointer), pointer;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
  text-align: center;
  flex-shrink: 0;  /* 不被压扁，让 scroll 正常工作 */
}
.qdp-titem:hover { background: rgb(var(--c-accent-light)); }
.qdp-titem.active {
  background: rgb(var(--c-accent));
  color: white;
  font-weight: 600;
}
.qdp-time-colon {
  color: #9ca3af;
  font-weight: 600;
}

/* ─── Actions ─── */
.qdp-actions {
  margin-top: 10px;
  display: flex;
  justify-content: space-between;
}
.qdp-btn-primary,
.qdp-btn-ghost {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 6px;
  border: none;
  font-family: inherit;
}
.qdp-btn-primary {
  background: rgb(var(--c-accent-light));
  color: rgb(var(--c-accent-dark));
}
.qdp-btn-primary:hover {
  background: rgb(var(--c-accent) / 0.2);
}
.qdp-btn-ghost {
  background: transparent;
  color: #9ca3af;
}
.qdp-btn-ghost:hover {
  background: #f3f4f6;
  color: #374151;
}

/* ─── Dark theme ─── */
[data-theme="dark"] .qdp-trigger {
  background: rgb(var(--c-sidebar-light));
  border-color: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.88);
}
[data-theme="dark"] .qdp-trigger.is-empty {
  color: rgba(255, 255, 255, 0.4);
}
[data-theme="dark"] .qdp-icon {
  color: rgba(255, 255, 255, 0.5);
}
[data-theme="dark"] .qdp-popup {
  background: rgb(var(--c-sidebar));
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.4);
}
[data-theme="dark"] .qdp-nav {
  color: rgba(255, 255, 255, 0.6);
}
[data-theme="dark"] .qdp-nav:hover {
  background: rgba(var(--c-accent) / 0.18);
  color: rgb(var(--c-accent));
}
[data-theme="dark"] .qdp-title {
  color: rgba(255, 255, 255, 0.88);
}
[data-theme="dark"] .qdp-weekdays {
  color: rgba(255, 255, 255, 0.4);
}
[data-theme="dark"] .qdp-cell {
  color: rgba(255, 255, 255, 0.85);
}
[data-theme="dark"] .qdp-cell:hover:not(.is-disabled):not(.is-selected) {
  background: rgba(var(--c-accent) / 0.18);
}
[data-theme="dark"] .qdp-cell.is-other {
  color: rgba(255, 255, 255, 0.2);
}
[data-theme="dark"] .qdp-cell.is-today {
  color: rgb(var(--c-accent));
}
[data-theme="dark"] .qdp-time {
  border-top-color: rgba(255, 255, 255, 0.08);
}
[data-theme="dark"] .qdp-time-label,
[data-theme="dark"] .qdp-time-colon {
  color: rgba(255, 255, 255, 0.5);
}
[data-theme="dark"] .qdp-tbtn {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
}
[data-theme="dark"] .qdp-tbtn:hover { border-color: rgba(var(--c-accent) / 0.5); }
[data-theme="dark"] .qdp-tbtn.open { border-color: rgb(var(--c-accent)); }
[data-theme="dark"] .qdp-tlist {
  background: rgb(var(--c-sidebar));
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 -8px 24px rgb(0 0 0 / 0.4);
}
[data-theme="dark"] .qdp-tlist::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
}
[data-theme="dark"] .qdp-tlist::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.28);
}
[data-theme="dark"] .qdp-titem { color: rgba(255, 255, 255, 0.85); }
[data-theme="dark"] .qdp-titem:hover { background: rgba(var(--c-accent) / 0.18); }
[data-theme="dark"] .qdp-titem.active {
  background: rgb(var(--c-accent));
  color: white;
}
[data-theme="dark"] .qdp-btn-ghost {
  color: rgba(255, 255, 255, 0.4);
}
[data-theme="dark"] .qdp-btn-ghost:hover {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.85);
}
</style>
