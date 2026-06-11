<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide, watch } from 'vue';
import { sharedPageCount } from '@/composables/usePageCount';
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
import { useNotesStore } from '@/stores/notes';
import { useGroupsStore } from '@/stores/groups';
import { pinyinMatch, highlightTextByPinyin } from '@/utils/pinyin';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const auth = useAuthStore();
const store = useNotesStore();
const hoveredId = ref<string | null>(null);
// 拆双 ref: allNotes 原始全集 (load 一次拉全), notes 过滤后用于显示 (useMasonry 只 watch 这个).
// 搜索 → notes = filter(allNotes) reassign 走 rebuild; 删除/恢复 → 双 splice mutation 保住 useMasonry
// 的 splice 优化路径, 否则 rebuild 会让 staying 卡片跨列重排, TransitionGroup 误触发 onLeave →
// 看着像"其他卡片跟着被删的一起飞向 sidebar" (Trash 用 flyToNavLeave 视觉特别明显, 详见 composables/CLAUDE.md 坑 6)
const allNotes = ref<Note[]>([]);
const notes = ref<Note[]>([]);
const pageCount = computed(() => notes.value.length);
onMounted(() => {
  sharedPageCount.value = pageCount.value;
  watch(pageCount, (v) => { sharedPageCount.value = v; });
});
onUnmounted(() => { sharedPageCount.value = -1; });

// 搜索: TopBar 把搜索词写入 store.searchQuery (trash 路径不走 fetchNotes), view 自己 watch 过滤;
// 过滤维度 = content + category + tag, 走 pinyinMatch 支持拼音 (跟 Tags / Resources 一致)
function applyFilter() {
  const q = store.searchQuery?.trim();
  if (!q) {
    notes.value = [...allNotes.value];
    return;
  }
  notes.value = allNotes.value.filter(n => {
    if (pinyinMatch(n.content || '', q)) return true;
    if (n.category && pinyinMatch(n.category, q)) return true;
    if (n.tags && (n.tags as string[]).some((t: string) => pinyinMatch(t, q))) return true;
    return false;
  });
}
watch(() => store.searchQuery, applyFilter);

// 搜索高亮: content 已是 HTML, 走"标签 vs 文本"分流再套 mark (跟 NoteCard 同模式), 否则 mark 注入到属性里破坏 HTML;
// category / tag 是纯文本直接套, 接受 tag 名含 < 等 HTML 字符可能导致渲染异常的边角情况 (实际几乎不会).
// 高亮用全局 .search-highlight 样式 (style.css:537), 主题色跟着换
function renderContentHl(id: string, raw: string): string {
  const html = rendered.value[id] || raw;
  const q = store.searchQuery?.trim();
  if (!q) return html;
  return html.replace(/(<[^>]+>)|([^<]+)/g, (_: string, tag: string, text: string) =>
    tag ? tag : highlightTextByPinyin(text, q)
  );
}
function highlightText(text: string): string {
  const q = store.searchQuery?.trim();
  if (!q) return text;
  return highlightTextByPinyin(text, q);
}

// 双 splice helper: 删除/恢复 时让显示和原始数据同步, 同时让 useMasonry 走 mutation 优化路径
function removeFromBoth(id: string) {
  let idx = notes.value.findIndex(n => n.id === id);
  if (idx >= 0) notes.value.splice(idx, 1);
  idx = allNotes.value.findIndex(n => n.id === id);
  if (idx >= 0) allNotes.value.splice(idx, 1);
}

// 多选模式 (Ctrl/Meta 单击触发, 跟主界面 NoteCard 一致), 但用 view 局部 state 不复用 store.selectMode
// — store 那套是给主界面 notes 列表用的, Trash 是独立 notes ref
const selectMode = ref(false);
const selectedIds = ref<Set<string>>(new Set());
useEscToClose(selectMode);
watch(selectMode, (v) => { if (!v) selectedIds.value.clear(); });

function toggleSelect(id: string) {
  if (selectedIds.value.has(id)) selectedIds.value.delete(id);
  else selectedIds.value.add(id);
  // 取消所有选中不自动退出 selectMode, 让用户用顶部"退出"按钮或 ESC 主动退出
  // (之前自动退出让 Ctrl+点击进入多选 → 立刻取消那张 → 自动退出, 体验突兀)
}

function onCardClick(e: MouseEvent, n: Note) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    selectMode.value = true;
    toggleSelect(n.id);
    return;
  }
  if (selectMode.value) {
    e.preventDefault();
    e.stopPropagation();
    toggleSelect(n.id);
  }
}

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

// 永久删除确认窗显示 "已分享到 N 群". 笔记保留 note_shares (软删时不清),
// 永久删除会同步清掉 note_shares 让历史也消失
const groupsStore = useGroupsStore();
const confirmDeleteShares = computed<string[]>(() => {
  if (!confirmDeleteId.value) return [];
  const n = allNotes.value.find(x => x.id === confirmDeleteId.value);
  return (n as any)?.sharedGroupIds ?? [];
});
const confirmDeleteGroupNames = computed<string[]>(() => {
  return confirmDeleteShares.value
    .map(id => groupsStore.groups.find(g => g.id === id)?.name)
    .filter((s): s is string => !!s);
});

// 瀑布流分列 (跟 Notes.vue / Inspiration.vue / Todos.vue 一致, 修早期遗漏的回归)
// rootRef 让 useMasonry 用真实 DOM 高度而非估算, 修 estimateHeight 误判最矮列的反馈循环
const masonryRoot = ref<HTMLElement | null>(null);
const { columns } = useMasonry(() => notes.value, masonryRoot);

async function load() {
  if (!isLoggedIn()) return;
  loading.value = true;
  try {
    const res = await api.getTrash();
    allNotes.value = res.data;
    for (const n of res.data) {
      try { rendered.value[n.id] = await Vditor.md2html(resolveMarkdownFileUrls(n.content), { cdn: '/vditor' } as any); } catch { rendered.value[n.id] = n.content; }
    }
    applyFilter();
  } catch {}
  loading.value = false;
}

const confirmRestoreId = ref('');
const confirmRestoreAll = ref(false);
const confirmBatchRestore = ref(false);
const confirmBatchDelete = ref(false);
useEscToClose(confirmRestoreId, '');
useEscToClose(confirmRestoreAll);
useEscToClose(confirmBatchRestore);
useEscToClose(confirmBatchDelete);

async function doRestore() {
  const id = confirmRestoreId.value;
  confirmRestoreId.value = '';
  if (!id) return;
  leaveMode = 'restore';
  try {
    await api.restoreNote(id);
    // 双 splice mutate (helper 包装): 显示用 notes + 原始 allNotes 同步移除.
    // 不用 filter 重赋值: reassign → useMasonry rebuild → 跨列重排 → 误调 flyToNavLeave 飞向 sidebar
    removeFromBoth(id);
  } catch {}
}

async function doRestoreAll() {
  confirmRestoreAll.value = false;
  leaveMode = 'restore';
  // 恢复所有 = 全集 (用 allNotes 不用 notes), 跟按钮文案语义一致, 搜索状态下也是清空整个回收站
  const restoringIds = allNotes.value.map(n => n.id);
  notes.value = [];
  allNotes.value = [];
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
    // 同 doRestore: 双 splice mutate 防止 useMasonry rebuild 跨列重排误触发其他卡片动画
    removeFromBoth(id);
  } catch {}
}

async function doEmptyAll() {
  confirmEmpty.value = false;
  leaveMode = 'delete';
  // 清空 = 全集 (跟恢复所有同语义)
  notes.value = [];
  allNotes.value = [];
  try {
    await api.emptyTrash();
  } catch (err) {
    console.error('[Trash] 清空回收站失败', err);
  }
}

// 批量恢复 / 永久删除: 用 splice mutate 防 useMasonry 跨列重排 (跟 doRestore / doPermanentDelete 同根因).
// 走乐观更新 + Promise.all 并发: 先从 UI 移除触发 leave 动画再并发跑 API (跟 doRestoreAll / doEmptyAll 同模式).
// 任一失败只 console.error 不回滚, server 数据不一致下次刷新自动同步 (详见根 CLAUDE.md 批量操作用乐观更新).
//
// 主动 snapshotCards(): 批量场景下连续多次 splice 触发的 watch sync snapshot 时序复杂
// (用户滚动 main 后, splice/selectMode 切换的 patch 顺序里 layout 可能微调, 让 flyToNavLeave
// 的起始坐标偏离用户视觉位置). 在 splice 之前主动 snapshot 一次, 缓存"用户点按钮那一瞬间"的所有
// 卡片 viewport 坐标, leave 钩子 100% 用这份 snapshot, 起点跟视觉对齐.
async function doBatchRestore() {
  confirmBatchRestore.value = false;
  const ids = Array.from(selectedIds.value);
  if (!ids.length) return;
  snapshotCards();
  leaveMode = 'restore';
  for (const id of ids) removeFromBoth(id);
  selectMode.value = false;
  await Promise.all(ids.map(id => api.restoreNote(id).catch(e => console.error('[batchRestore]', id, e))));
}

async function doBatchDelete() {
  confirmBatchDelete.value = false;
  const ids = Array.from(selectedIds.value);
  if (!ids.length) return;
  snapshotCards();
  leaveMode = 'delete';
  for (const id of ids) removeFromBoth(id);
  selectMode.value = false;
  await Promise.all(ids.map(id => api.permanentDeleteNote(id).catch(e => console.error('[batchDelete]', id, e))));
}

function deletedAgo(n: any) {
  return n.deletedAt ? dayjs(n.deletedAt).fromNow() + '删除' : '';
}

// 命名约定: quink=灵感, note=笔记, todo=待办. link 类型已废弃删
const typeLabels: Record<string, string> = { quink: '灵感', note: '笔记', todo: '待办' };
const typeColor: Record<string, string> = {
  quink: 'type-chip-quink', // 固定 blueberry, 不跟主题 (style.css 定义 + dark 适配)
  note: 'bg-emerald-100 text-emerald-600',
  todo: 'bg-amber-100 text-amber-600',
};

function onRefresh() { load(); }
// 多设备同步: SSE 收到 note-deleted (软删/彻底删) 或 trash-cleared 时同步本地, 不调 API
function onNoteDeletedExternal(e: Event) {
  const id = (e as CustomEvent).detail?.noteId;
  if (!id) return;
  const idx = notes.value.findIndex(n => n.id === id);
  if (idx >= 0) {
    // 当前列表里有这条 → 永久删除场景, 直接移除
    notes.value.splice(idx, 1);
  } else {
    // 列表里没有 → 可能是软删 (其他设备 trash 应该多一条), 重拉一次
    void load();
  }
}
function onTrashClearedExternal() { notes.value = []; }
onMounted(() => {
  load();
  window.addEventListener('quink-refresh', onRefresh);
  window.addEventListener('quink-note-deleted', onNoteDeletedExternal);
  window.addEventListener('quink-trash-cleared', onTrashClearedExternal);
});
onUnmounted(() => {
  window.removeEventListener('quink-refresh', onRefresh);
  window.removeEventListener('quink-note-deleted', onNoteDeletedExternal);
  window.removeEventListener('quink-trash-cleared', onTrashClearedExternal);
});

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
  <div class="px-4 md:px-8 pb-6">
    <!-- toolbar 完全套用 TopBar batch action bar 的 class (px-4 md:px-6 py-2 + border-t border-gray-100 + bg-gray-50/80),
         多余的 sticky 部分 (sticky top-0 z-10 -mx + mb-4 + justify-between) 是 Trash 独有需求 (Trash 在 main 内, TopBar batch bar 在 header 内不需要 sticky).
         根 div 顶部 padding 必须去掉 (改 pb-6 只留底部) 否则 sticky 不立即钉住. 资源页加同款多选时复用这套 class. -->
    <!-- v-if 用 allNotes.length: 搜索没结果时也保留工具栏, 让用户能继续退出搜索 / 多选 / 恢复所有 -->
    <div v-if="allNotes.length > 0"
      class="sticky top-0 z-[var(--z-sticky)] -mx-4 md:-mx-8 px-4 md:px-6 pt-[8px] pb-[10px] mb-4 flex items-center justify-between gap-3 border-t border-gray-100 bg-gray-50/80"
      style="box-shadow: 0 1px 3px var(--c-topbar-shadow), 0 1px 0 var(--sb-border)">
      <p v-if="!selectMode" class="text-xs text-gray-400">{{ notes.length }} 条已删除的内容</p>
      <p v-else class="text-xs text-primary-dark font-medium">已选 {{ selectedIds.size }} 条</p>
      <div class="flex items-center gap-2">
        <template v-if="selectMode">
          <button @click="confirmBatchRestore = true" :disabled="!selectedIds.size"
            class="px-3 py-1 text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            批量恢复
          </button>
          <button @click="confirmBatchDelete = true" :disabled="!selectedIds.size"
            class="px-3 py-1 text-xs rounded-lg font-medium bg-red-50 text-red-500 hover:bg-red-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            批量永久删除
          </button>
          <button @click="selectMode = false" class="px-3 py-1 text-xs rounded-lg font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">
            退出
          </button>
        </template>
        <template v-else>
          <button @click="confirmRestoreAll = true" class="px-3 py-1 text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:opacity-80 transition-colors">
            恢复所有
          </button>
          <button @click="confirmEmpty = true" class="px-3 py-1 text-xs rounded-lg font-medium bg-red-50 text-red-500 hover:bg-red-100 transition-colors">
            清空回收站
          </button>
          <button @click="selectMode = true"
            class="px-3 py-1 text-xs rounded-lg font-medium bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors">
            多选
          </button>
        </template>
      </div>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <!-- 空状态分两种: 回收站本身为空 vs 搜索没匹配. 用 empty-state-center 跟其他 view 统一对齐 viewport 中线 -->
      <div v-if="allNotes.length === 0" class="empty-state-center">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhTrash size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">回收站是空的</p>
        <p class="text-gray-400 text-xs mt-1">删除的内容会在这里保留30天</p>
      </div>
      <div v-else-if="notes.length === 0" class="empty-state-center">
        <p class="text-gray-500 text-lg">没有匹配的内容</p>
      </div>

      <div ref="masonryRoot" class="notes-masonry">
        <TransitionGroup v-for="(col, ci) in columns" :key="ci" tag="div"
          data-animated-list class="masonry-col" :css="false" @leave="onLeave">
          <div v-for="n in col" :key="n.id" :data-note-type="n.type"
            class="bg-white rounded-2xl shadow-sm border overflow-hidden group transition-all duration-200 cursor-default"
            :class="selectedIds.has(n.id) ? 'border-primary ring-2 ring-primary' : 'border-gray-100'"
            @click="onCardClick($event, n)">
            <div class="px-4 py-3">
              <!-- 顶部行: selectMode 时左侧加 checkbox + 类型 chip + 分类, 右侧 删除时间 -->
              <div class="flex items-center gap-2 mb-2">
                <div v-if="selectMode"
                  class="w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 transition-all"
                  :class="selectedIds.has(n.id) ? 'bg-primary border-primary' : 'border-gray-400 bg-white'">
                  <svg v-if="selectedIds.has(n.id)" class="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12l5 5L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </div>
                <span class="text-[11px] px-2 py-0.5 rounded-full font-medium select-none" :class="typeColor[n.type]">
                  {{ typeLabels[n.type] }}
                </span>
                <span v-if="n.category" class="text-xs text-gray-400" v-html="highlightText(n.category)" />
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
                <div class="vditor-reset line-clamp-4" v-html="renderContentHl(n.id, n.content)" />
              </div>
              <!-- 标签放在内容下方 (跟 NoteCard 一致) -->
              <div v-if="n.tags && (n.tags as string[]).length > 0" class="flex flex-wrap gap-1.5 mt-2">
                <span v-for="tag in (n.tags as string[])" :key="tag" class="text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full"
                  v-html="'#' + highlightText(tag)" />
              </div>
            </div>
            <!-- selectMode 时隐藏底部单条按钮区, 避免"选中"和"单条操作"语义冲突 -->
            <div v-if="!selectMode" class="flex items-center gap-1 px-3 py-2 border-t border-gray-50 opacity-0 group-hover:opacity-100 transition-opacity">
              <button @click.stop="confirmRestoreId = n.id" class="px-3 py-1 text-xs bg-primary-light text-primary-dark hover:opacity-80 rounded-lg transition-colors">
                恢复
              </button>
              <button @click.stop="confirmDeleteId = n.id" class="px-3 py-1 text-xs ml-auto rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors">
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
      <div v-if="confirmDeleteId" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmDeleteId = ''" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 text-center">
          <p class="text-sm text-gray-700 mb-1">永久删除</p>
          <p class="text-xs text-gray-400 mb-2">此操作不可恢复</p>
          <!-- 提醒共享笔记删除后群里历史也消失 -->
          <p v-if="confirmDeleteShares.length > 0" class="text-xs text-red-500 mb-4">
            已分享到
            <template v-if="confirmDeleteGroupNames.length > 0">
              <span v-for="(name, i) in confirmDeleteGroupNames" :key="name">
                <span class="font-medium">「{{ name }}」</span><span v-if="i < confirmDeleteGroupNames.length - 1">、</span>
              </span>
            </template>
            <template v-else>{{ confirmDeleteShares.length }} 个群组</template>
            , 删除后群内也消失
          </p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmDeleteId = ''" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doPermanentDelete" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">永久删除</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 清空回收站确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmEmpty" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmEmpty = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">清空回收站</p>
          <p class="text-xs text-gray-400 mb-4">将永久删除所有 {{ allNotes.length }} 条内容，不可恢复</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmEmpty = false" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doEmptyAll" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">清空</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 恢复确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmRestoreId" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmRestoreId = ''" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">恢复内容</p>
          <p class="text-xs text-gray-400 mb-4">将从回收站恢复此条内容</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmRestoreId = ''" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doRestore" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium transition-colors" style="background: rgb(var(--c-accent))">恢复</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 恢复所有确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmRestoreAll" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmRestoreAll = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">恢复所有</p>
          <p class="text-xs text-gray-400 mb-4">将恢复回收站中全部 {{ allNotes.length }} 条内容</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmRestoreAll = false" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doRestoreAll" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium transition-colors" style="background: rgb(var(--c-accent))">恢复所有</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 批量恢复确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmBatchRestore" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmBatchRestore = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">批量恢复</p>
          <p class="text-xs text-gray-400 mb-4">将恢复选中的 {{ selectedIds.size }} 条内容</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmBatchRestore = false" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doBatchRestore" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium transition-colors" style="background: rgb(var(--c-accent))">恢复</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 批量永久删除确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmBatchDelete" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmBatchDelete = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">批量永久删除</p>
          <p class="text-xs text-gray-400 mb-4">将永久删除选中的 {{ selectedIds.size }} 条内容，不可恢复</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmBatchDelete = false" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doBatchDelete" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">永久删除</button>
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

