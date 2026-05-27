<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide, watch } from 'vue';
import { api, isLoggedIn, type Note } from '@/api';
import Vditor from 'vditor';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { PhTrash } from '@phosphor-icons/vue';
import { fadeOutLeave, flyToNavLeave, snapshotCards } from '@/utils/cardLeave';
import { resolveMarkdownFileUrls } from '@/utils/fileUrl';
import { useMasonry } from '@/composables/useMasonry';
import { useEscToClose } from '@/composables/useEscToClose';
import { useAuthStore } from '@/stores/auth';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const auth = useAuthStore();
const hoveredId = ref<string | null>(null);
const notes = ref<Note[]>([]);
const pageCount = computed(() => notes.value.length);
provide('pageCount', pageCount);

// 单卡片悬停显示"X 天后自动删除", 永久保留则不显示 tooltip
function daysLeftTooltip(n: any): string | undefined {
  const raw = (auth.user?.preferences as any)?.trashRetentionDays;
  const days = typeof raw === 'number' && raw >= 0 ? raw : 30;
  if (days === 0 || !n.deletedAt) return undefined;
  const cutoff = dayjs(n.deletedAt).add(days, 'day');
  const now = dayjs();
  const daysLeft = cutoff.diff(now, 'day');
  if (daysLeft >= 1) return `${daysLeft} 天后自动删除`;
  const hoursLeft = cutoff.diff(now, 'hour');
  if (hoursLeft >= 1) return `${hoursLeft} 小时后自动删除`;
  return '即将自动删除';
}
const loading = ref(true);
const confirmEmpty = ref(false);
const confirmDeleteId = ref('');
const rendered = ref<Record<string, string>>({});
useEscToClose(confirmEmpty);
useEscToClose(confirmDeleteId, '');

// 瀑布流分列 (跟 Notes.vue / Inspiration.vue / Todos.vue 一致, 修早期遗漏的回归)
const { columns } = useMasonry(() => notes.value);

async function load() {
  if (!isLoggedIn()) return;
  loading.value = true;
  try {
    const res = await api.getTrash();
    notes.value = res.data;
    for (const n of res.data) {
      try { rendered.value[n.id] = await Vditor.md2html(resolveMarkdownFileUrls(n.content), { cdn: '/vditor' } as any); } catch { rendered.value[n.id] = n.content; }
    }
  } catch {}
  loading.value = false;
}

const confirmRestoreId = ref('');
const confirmRestoreAll = ref(false);
useEscToClose(confirmRestoreId, '');
useEscToClose(confirmRestoreAll);

async function doRestore() {
  const id = confirmRestoreId.value;
  confirmRestoreId.value = '';
  if (!id) return;
  leaveMode = 'restore';
  try {
    await api.restoreNote(id);
    // 必须 findIndex + splice mutate, 不能用 filter 重新赋值: 后者是 reassign → useMasonry watch
    // 走 rebuild 分支 → 跨列重排 → 其他卡片在原 col 触发 leave (误调 flyToNavLeave 飞向 sidebar) +
    // 新 col 触发 enter → 视觉上"所有卡片跟着被恢复那张一起飞". 范例: stores/notes.ts deleteNote 同改法
    const idx = notes.value.findIndex(n => n.id === id);
    if (idx >= 0) notes.value.splice(idx, 1);
  } catch {}
}

async function doRestoreAll() {
  confirmRestoreAll.value = false;
  leaveMode = 'restore';
  const restoringIds = notes.value.map(n => n.id);
  notes.value = [];
  try {
    await Promise.all(restoringIds.map(id => api.restoreNote(id)));
  } catch (err) {
    console.error('[Trash] 恢复所有部分失败', err);
  }
}

async function doPermanentDelete() {
  const id = confirmDeleteId.value;
  confirmDeleteId.value = '';
  if (!id) return;
  leaveMode = 'delete';
  try {
    await api.permanentDeleteNote(id);
    // 同 doRestore: 必须 splice mutate 防止 useMasonry rebuild 跨列重排误触发其他卡片动画
    const idx = notes.value.findIndex(n => n.id === id);
    if (idx >= 0) notes.value.splice(idx, 1);
  } catch {}
}

async function doEmptyAll() {
  confirmEmpty.value = false;
  leaveMode = 'delete';
  notes.value = [];
  try {
    await api.emptyTrash();
  } catch (err) {
    console.error('[Trash] 清空回收站失败', err);
  }
}

function deletedAgo(n: any) {
  return n.deletedAt ? dayjs(n.deletedAt).fromNow() + '删除' : '';
}

// 跟 NoteCard 一致, 让回收站卡片视觉风格统一
const typeLabels: Record<string, string> = { note: '灵感', todo: '待办', snippet: '笔记', link: '链接' };
const typeColor: Record<string, string> = {
  note: 'bg-primary-light text-primary',
  todo: 'bg-amber-100 text-amber-600',
  snippet: 'bg-emerald-100 text-emerald-600',
  link: 'bg-sky-100 text-sky-600',
};

function onRefresh() { load(); }
onMounted(() => { load(); window.addEventListener('quink-refresh', onRefresh); });
onUnmounted(() => { window.removeEventListener('quink-refresh', onRefresh); });

// 数据变更前主动 snapshot 所有卡片位置，避免 onLeave 钩子里拿到的是 v-if 切换后的错位坐标
watch(() => notes.value.length, () => snapshotCards(), { flush: 'sync' });

// leave 动画的触发上下文：'delete' 用纯淡出；'restore' 用 macOS 风的向上飞
let leaveMode: 'delete' | 'restore' = 'delete';
function onLeave(el: Element, done: () => void) {
  if (leaveMode === 'restore') flyToNavLeave(el, done);
  else fadeOutLeave(el, done);
}
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <div class="flex items-center justify-between mb-6" v-if="notes.length > 0">
      <p class="text-xs text-gray-400">{{ notes.length }} 条已删除的内容</p>
      <div class="flex items-center gap-2">
        <button @click="confirmRestoreAll = true" class="px-3 py-1.5 text-xs rounded-lg bg-primary-light text-primary-dark hover:opacity-80 transition-colors">
          恢复所有
        </button>
        <button @click="confirmEmpty = true" class="px-3 py-1.5 text-xs rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors">
          清空回收站
        </button>
      </div>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <div v-if="notes.length === 0" class="text-center py-16">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhTrash size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">回收站是空的</p>
        <p class="text-gray-400 text-xs mt-1">删除的内容会在这里保留30天</p>
      </div>

      <div class="notes-masonry">
        <TransitionGroup v-for="(col, ci) in columns" :key="ci" tag="div"
          data-animated-list class="masonry-col" :css="false" @leave="onLeave">
          <div v-for="n in col" :key="n.id" :data-note-type="n.type" class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden group transition-transform duration-300">
            <div class="px-4 py-3">
              <!-- 顶部行: 左侧 类型 chip + 分类, 右侧 删除时间 (ml-auto 推到最右) -->
              <div class="flex items-center gap-2 mb-2">
                <span class="text-[11px] px-2 py-0.5 rounded-full font-medium select-none" :class="typeColor[n.type]">
                  {{ typeLabels[n.type] }}
                </span>
                <span v-if="n.category" class="text-xs text-gray-400">{{ n.category }}</span>
                <span
                  class="ml-auto text-[11px] cursor-default transition-colors"
                  :class="hoveredId === n.id && daysLeftTooltip(n) ? 'text-red-400' : 'text-gray-400'"
                  @mouseenter="hoveredId = n.id"
                  @mouseleave="hoveredId = null"
                >
                  {{ hoveredId === n.id && daysLeftTooltip(n) ? daysLeftTooltip(n) : deletedAgo(n) }}
                </span>
              </div>
              <div class="text-gray-500 note-content">
                <div class="vditor-reset line-clamp-4" v-html="rendered[n.id] || n.content" />
              </div>
              <!-- 标签放在内容下方 (跟 NoteCard 一致) -->
              <div v-if="n.tags && (n.tags as string[]).length > 0" class="flex flex-wrap gap-1.5 mt-2">
                <span v-for="tag in (n.tags as string[])" :key="tag" class="text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                  #{{ tag }}
                </span>
              </div>
            </div>
            <div class="flex items-center gap-1 px-3 py-2 border-t border-gray-50 opacity-0 group-hover:opacity-100 transition-opacity">
              <button @click="confirmRestoreId = n.id" class="px-3 py-1 text-xs bg-primary-light text-primary-dark hover:opacity-80 rounded-lg transition-colors">
                恢复
              </button>
              <button @click="confirmDeleteId = n.id" class="px-3 py-1 text-xs ml-auto rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors">
                永久删除
              </button>
            </div>
          </div>
        </TransitionGroup>
      </div>
    </template>
  </div>

  <!-- 永久删除确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmDeleteId" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmDeleteId = ''" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">永久删除</p>
          <p class="text-xs text-gray-400 mb-4">此操作不可恢复</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmDeleteId = ''" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doPermanentDelete" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">永久删除</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 清空回收站确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmEmpty" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmEmpty = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">清空回收站</p>
          <p class="text-xs text-gray-400 mb-4">将永久删除所有 {{ notes.length }} 条内容，不可恢复</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmEmpty = false" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doEmptyAll" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">清空</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 恢复确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmRestoreId" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmRestoreId = ''" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">恢复内容</p>
          <p class="text-xs text-gray-400 mb-4">将从回收站恢复此条内容</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmRestoreId = ''" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doRestore" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium transition-colors" style="background: rgb(var(--c-accent))">恢复</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 恢复所有确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmRestoreAll" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmRestoreAll = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">恢复所有</p>
          <p class="text-xs text-gray-400 mb-4">将恢复回收站中全部 {{ notes.length }} 条内容</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmRestoreAll = false" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doRestoreAll" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium transition-colors" style="background: rgb(var(--c-accent))">恢复所有</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.line-clamp-4 {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>

