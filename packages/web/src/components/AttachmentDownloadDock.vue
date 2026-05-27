<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { PhX, PhCheck, PhWarning, PhCaretUp, PhCaretDown } from '@phosphor-icons/vue';
import { tasks, dockVisible, cancelTask, dismissTask, pauseAutoClose, resumeAutoClose, type AttachmentTask } from '@/composables/useAttachmentTasks';

const PAGE_SIZE = 3;
const currentPage = ref(0);

const totalPages = computed(() => Math.max(1, Math.ceil(tasks.value.length / PAGE_SIZE)));

const visibleTasks = computed<AttachmentTask[]>(() => {
  const start = currentPage.value * PAGE_SIZE;
  return tasks.value.slice(start, start + PAGE_SIZE);
});

// 翻页时若末页不足 3 条, 用空 li 占位保持 3 行高度(蘑菇要求"可翻页时高度不变"). 单页(<=3 条)不占位
const placeholderCount = computed(() =>
  totalPages.value > 1 ? Math.max(0, PAGE_SIZE - visibleTasks.value.length) : 0
);

// 新任务进来时跳到末页, 让用户看到最新
watch(
  () => tasks.value.length,
  (n, prev) => {
    if (n > prev) {
      currentPage.value = Math.max(0, Math.ceil(n / PAGE_SIZE) - 1);
    } else if (currentPage.value >= totalPages.value) {
      // 翻页中间的某条被移除导致当前页越界 → 回到上一页
      currentPage.value = Math.max(0, totalPages.value - 1);
    }
  }
);

function percent(t: AttachmentTask): number {
  if (t.status === 'success') return 100;
  if (t.status === 'failed') return 100;
  if (!t.total) return 0;
  return Math.min(100, Math.round((t.received / t.total) * 100));
}

function formatBytes(b: number): string {
  if (b <= 0) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

function sizeText(t: AttachmentTask): string {
  if (t.status === 'success') return '已完成';
  if (t.status === 'failed') return t.error || '失败';
  if (!t.total) return formatBytes(t.received);
  return `${formatBytes(t.received)} / ${formatBytes(t.total)}`;
}

function onCancel(url: string): void {
  cancelTask(url);
}

function onDismiss(url: string): void {
  dismissTask(url);
}

function prevPage(): void {
  if (currentPage.value > 0) currentPage.value--;
}
function nextPage(): void {
  if (currentPage.value < totalPages.value - 1) currentPage.value++;
}
</script>

<template>
  <Transition name="dock-fade">
    <div
      v-if="dockVisible && tasks.length > 0"
      class="fixed left-1/2 -translate-x-1/2 z-[110] w-[360px] bg-white rounded-xl shadow-xl border border-gray-200 overflow-hidden"
      style="bottom: 24px"
      @mouseenter="pauseAutoClose"
      @mouseleave="resumeAutoClose"
    >
      <!-- 顶部翻页栏(仅 > 3 条时显示) -->
      <div
        v-if="totalPages > 1"
        class="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-100 text-xs text-gray-500"
      >
        <span>下载列表 ({{ tasks.length }})</span>
        <div class="flex items-center gap-1">
          <span class="tabular-nums">{{ currentPage + 1 }} / {{ totalPages }}</span>
          <button
            class="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
            :disabled="currentPage === 0"
            @click="prevPage"
            title="上一页"
          >
            <PhCaretUp size="0.75rem" weight="bold" />
          </button>
          <button
            class="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
            :disabled="currentPage >= totalPages - 1"
            @click="nextPage"
            title="下一页"
          >
            <PhCaretDown size="0.75rem" weight="bold" />
          </button>
        </div>
      </div>

      <!-- ul 用 divide-y 在子项之间加分隔线(给非首个 li 加 border-top),
           避免 last:border-b-0 带来的"最后一个 li 少 1px"问题导致 dock 不同页高度差 -->
      <ul class="divide-y divide-gray-50">
        <li
          v-for="t in visibleTasks"
          :key="t.id"
          class="px-3 py-2"
        >
          <!-- 上行: 文件名 + 状态按钮/图标 -->
          <div class="flex items-center justify-between gap-2 mb-1">
            <div class="flex-1 min-w-0 text-sm text-gray-700 truncate" :title="t.filename">
              {{ t.filename }}
            </div>
            <button
              v-if="t.status === 'downloading'"
              @click="onCancel(t.url)"
              class="shrink-0 p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"
              title="取消下载"
            >
              <PhX size="0.875rem" weight="bold" />
            </button>
            <span v-else-if="t.status === 'success'" class="shrink-0 p-1 text-green-600" title="已打开">
              <PhCheck size="0.875rem" weight="bold" />
            </span>
            <!-- 失败状态: 按钮可点击 dismiss(从列表移除 + 触发 3s 关窗倒计时) -->
            <button
              v-else-if="t.status === 'failed'"
              @click="onDismiss(t.url)"
              class="shrink-0 p-1 rounded hover:bg-red-50 text-red-500 hover:text-red-600"
              title="忽略并关闭"
            >
              <PhX size="0.875rem" weight="bold" />
            </button>
          </div>
          <!-- 下行: 进度条 + 百分比/大小 -->
          <div class="flex items-center gap-2">
            <div class="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-[width] duration-150 ease-out"
                :class="{
                  'bg-primary': t.status === 'downloading',
                  'bg-green-500': t.status === 'success',
                  'bg-red-400': t.status === 'failed',
                }"
                :style="{ width: percent(t) + '%' }"
              />
            </div>
            <div class="shrink-0 text-[10px] tabular-nums text-gray-500 w-[110px] text-right truncate">
              <span v-if="t.status === 'downloading'">{{ percent(t) }}% · {{ sizeText(t) }}</span>
              <span v-else>{{ sizeText(t) }}</span>
            </div>
          </div>
        </li>
        <!-- 占位行: 末页不足 3 条时填补, 保持 dock 总高度不变.
             结构跟正常 li 完全一致(同样的标签 / class / 文字字号 line-height), 只用 invisible 整体隐藏,
             避免占位行内 span vs button / text-sm vs 默认 line-height 差异导致行高错位 -->
        <li
          v-for="i in placeholderCount"
          :key="`ph-${i}`"
          class="px-3 py-2 invisible"
          aria-hidden="true"
        >
          <div class="flex items-center justify-between gap-2 mb-1">
            <div class="flex-1 min-w-0 text-sm text-gray-700 truncate">·</div>
            <button class="shrink-0 p-1 rounded">
              <PhX size="0.875rem" weight="bold" />
            </button>
          </div>
          <div class="flex items-center gap-2">
            <div class="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div class="h-full rounded-full" style="width: 0%" />
            </div>
            <div class="shrink-0 text-[10px] tabular-nums text-gray-500 w-[110px] text-right truncate">
              <span>0% · 0 B</span>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </Transition>
</template>

<style scoped>
.dock-fade-enter-active,
.dock-fade-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.dock-fade-enter-from,
.dock-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(10px);
}
</style>
