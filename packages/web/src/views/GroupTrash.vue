<script setup lang="ts">
// 群组回收站 view. 路由 /groups/:id/trash, 仅 owner+admin 可进, 仅 owner 可永久删/清空.
// 仿 Trash.vue 80%, 差异: 数据源 group API / 显示"被 @X 删除" / retentionDays 来自 response (7天) /
// 监听 quink-group-trash-changed window event / 顶栏显示"「群名」的回收站" + 返回按钮.
import { ref, computed, onMounted, onUnmounted, watch, inject, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { sharedPageCount } from '@/composables/usePageCount';
import { api, isLoggedIn } from '@/api';
import Vditor from 'vditor';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { PhTrash } from '@phosphor-icons/vue';
import { fadeOutLeave, flyToNavLeave, snapshotCards } from '@/utils/cardLeave';
import { resolveMarkdownFileUrls } from '@/utils/fileUrl';
import { useMasonry } from '@/composables/useMasonry';
import { useEscToClose } from '@/composables/useEscToClose';
import { useNotesStore } from '@/stores/notes';
import { useGroupsStore } from '@/stores/groups';
import { useAuthStore } from '@/stores/auth';
import { pinyinMatch, highlightTextByPinyin } from '@/utils/pinyin';
import { useToast } from '@/composables/useToast';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

// 群回收站行: 字段是 GET /:id/trash 后端手写 SQL JOIN 返的子集 + 额外字段 (deletedBy / authorNickname).
// 不 extends Note (Note 严格不含 deletedAt, authorNickname 类型也不兼容 null)
interface TrashNote {
  id: string;
  userId?: string | null;
  content: string;
  category?: string | null;
  tags?: string[];
  type: 'quink' | 'note' | 'todo';
  deletedAt?: string | null;
  deletedByUserId?: string | null;
  deletedByNickname?: string | null;
  authorNickname?: string | null;
  authorAvatar?: string | null;
}

const route = useRoute();
const router = useRouter();
const store = useNotesStore();
const groupsStore = useGroupsStore();
const auth = useAuthStore();
const toast = useToast();

const groupId = computed(() => route.params.id as string);
const group = computed(() => groupsStore.groups.find(g => g.id === groupId.value));
// 权限: 仅 owner+admin 进群回收站; 仅 owner 才能永久删/清空 (跟后端约束一致)
const myRole = computed(() => (group.value as any)?.myRole as string | undefined);
const isOwner = computed(() => myRole.value === 'owner');
const canEnter = computed(() => myRole.value === 'owner' || myRole.value === 'admin');

// 走 detailTitle inject 让 TopBar 显示"「群名」的回收站(数量)",
// view 顶部只留返回按钮, 跟 NoteDetail 同款模式. 不再 view 内 H2 重复标题
const detailTitle = inject<Ref<string>>('detailTitle');
function syncDetailTitle() {
  if (detailTitle) detailTitle.value = `「${group.value?.name || '群组'}」的回收站`;
}
watch(() => group.value?.name, syncDetailTitle);

const hoveredId = ref<string | null>(null);
const allNotes = ref<TrashNote[]>([]);
const notes = ref<TrashNote[]>([]);
const retentionDays = ref(7);
const pageCount = computed(() => notes.value.length);
onMounted(() => {
  sharedPageCount.value = pageCount.value;
  watch(pageCount, (v) => { sharedPageCount.value = v; });
});
onUnmounted(() => { sharedPageCount.value = -1; });

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

function removeFromBoth(id: string) {
  let idx = notes.value.findIndex(n => n.id === id);
  if (idx >= 0) notes.value.splice(idx, 1);
  idx = allNotes.value.findIndex(n => n.id === id);
  if (idx >= 0) allNotes.value.splice(idx, 1);
}

const selectMode = ref(false);
const selectedIds = ref<Set<string>>(new Set());
useEscToClose(selectMode);
watch(selectMode, (v) => { if (!v) selectedIds.value.clear(); });

function toggleSelect(id: string) {
  if (selectedIds.value.has(id)) selectedIds.value.delete(id);
  else selectedIds.value.add(id);
}

function onCardClick(e: MouseEvent, n: TrashNote) {
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

function daysLeftTooltip(n: TrashNote): string | undefined {
  if (retentionDays.value === 0 || !n.deletedAt) return undefined;
  const cutoff = dayjs(n.deletedAt).add(retentionDays.value, 'day');
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

const masonryRoot = ref<HTMLElement | null>(null);
const { columns } = useMasonry(() => notes.value, masonryRoot);

async function load() {
  if (!isLoggedIn() || !groupId.value) return;
  loading.value = true;
  try {
    const res = await api.getGroupTrash(groupId.value);
    allNotes.value = res.data as TrashNote[];
    retentionDays.value = res.retentionDays ?? 7;
    for (const n of res.data) {
      try { rendered.value[n.id] = await Vditor.md2html(resolveMarkdownFileUrls(n.content), { cdn: '/vditor' } as any); } catch { rendered.value[n.id] = n.content; }
    }
    applyFilter();
  } catch (e: any) {
    if (e?.status === 403) {
      toast.show('你不是该群管理员', 'error', 3000);
      router.replace(`/groups/${groupId.value}`);
      return;
    }
    toast.show('加载失败', 'error');
  }
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
    await api.restoreFromGroupTrash(groupId.value, id);
    removeFromBoth(id);
    notifyGroupTrashChanged();
  } catch (e: any) {
    toast.show(e?.message || '恢复失败', 'error');
  }
}

async function doRestoreAll() {
  confirmRestoreAll.value = false;
  leaveMode = 'restore';
  const restoringIds = allNotes.value.map(n => n.id);
  notes.value = [];
  allNotes.value = [];
  try {
    await Promise.all(restoringIds.map(id => api.restoreFromGroupTrash(groupId.value, id)));
  } catch (err) {
    console.error('[GroupTrash] 恢复所有部分失败', err);
  }
  notifyGroupTrashChanged();
}

async function doPermanentDelete() {
  const id = confirmDeleteId.value;
  confirmDeleteId.value = '';
  if (!id || !isOwner.value) return;
  leaveMode = 'delete';
  try {
    await api.permanentDeleteFromGroupTrash(groupId.value, id);
    removeFromBoth(id);
    notifyGroupTrashChanged();
  } catch (e: any) {
    toast.show(e?.message || '永久删除失败', 'error');
  }
}

async function doEmptyAll() {
  confirmEmpty.value = false;
  if (!isOwner.value) return;
  leaveMode = 'delete';
  notes.value = [];
  allNotes.value = [];
  try {
    await api.emptyGroupTrash(groupId.value);
  } catch (err) {
    console.error('[GroupTrash] 清空回收站失败', err);
  }
  notifyGroupTrashChanged();
}

async function doBatchRestore() {
  confirmBatchRestore.value = false;
  const ids = Array.from(selectedIds.value);
  if (!ids.length) return;
  snapshotCards();
  leaveMode = 'restore';
  for (const id of ids) removeFromBoth(id);
  selectMode.value = false;
  await Promise.all(ids.map(id => api.restoreFromGroupTrash(groupId.value, id).catch(e => console.error('[batchRestore]', id, e))));
  notifyGroupTrashChanged();
}

async function doBatchDelete() {
  confirmBatchDelete.value = false;
  if (!isOwner.value) return;
  const ids = Array.from(selectedIds.value);
  if (!ids.length) return;
  snapshotCards();
  leaveMode = 'delete';
  for (const id of ids) removeFromBoth(id);
  selectMode.value = false;
  await Promise.all(ids.map(id => api.permanentDeleteFromGroupTrash(groupId.value, id).catch(e => console.error('[batchDelete]', id, e))));
  notifyGroupTrashChanged();
}

function deletedInfo(n: TrashNote): string {
  const when = n.deletedAt ? dayjs(n.deletedAt).fromNow() : '';
  // 被自己的笔记被自己删 (admin 也是 author 的情况) 不展示"被 @X 删除"避免冗余
  if (!n.deletedByUserId || n.deletedByUserId === n.userId) {
    return `${when}删除`;
  }
  const who = n.deletedByNickname || '管理员';
  return `${when} · 被 @${who} 删除`;
}

const typeLabels: Record<string, string> = { quink: '灵感', note: '笔记', todo: '待办' };
const typeColor: Record<string, string> = {
  quink: 'type-chip-quink', // 固定 blueberry, 不跟主题 (style.css 定义 + dark 适配)
  note: 'bg-emerald-100 text-emerald-600',
  todo: 'bg-amber-100 text-amber-600',
};

function onRefresh() { load(); }
// 多设备同步: 后端 publish 'group-trash-changed' → sse.ts 派 quink-group-trash-changed → 这里 reload
function onGroupTrashChanged(e: Event) {
  const detail = (e as CustomEvent).detail;
  if (detail?.groupId && detail.groupId !== groupId.value) return;
  void load();
}

onMounted(async () => {
  // 先确保 group 信息已加载 (用户直接 URL 访问时 groupsStore.groups 可能空 / 缺当前群 myRole)
  if (!group.value || !(group.value as any).myRole) {
    try { await groupsStore.loadGroup(groupId.value); } catch {}
  }
  // 权限校验: 非 owner/admin 跳回群详情页
  if (!canEnter.value) {
    toast.show('你不是该群管理员', 'error', 3000);
    router.replace(`/groups/${groupId.value}`);
    return;
  }
  syncDetailTitle();
  load();
  window.addEventListener('quink-refresh', onRefresh);
  window.addEventListener('quink-group-trash-changed', onGroupTrashChanged);
});
onUnmounted(() => {
  if (detailTitle) detailTitle.value = '';
  window.removeEventListener('quink-refresh', onRefresh);
  window.removeEventListener('quink-group-trash-changed', onGroupTrashChanged);
});

watch(() => notes.value.length, () => snapshotCards(), { flush: 'sync' });

let leaveMode: 'delete' | 'restore' = 'delete';
function onLeave(el: Element, done: () => void) {
  if (leaveMode === 'restore') flyToNavLeave(el, done);
  else fadeOutLeave(el, done);
}

// 返回按钮挪到 TopBar (TopBar.vue group-trash 路由专属), goBack 函数已废, view 内无入口

// 操作完成派事件让 GroupDetail 刷 trashCount 胶囊 (SSE 派的同款 event 复用 listener)
function notifyGroupTrashChanged() {
  window.dispatchEvent(new CustomEvent('quink-group-trash-changed', { detail: { groupId: groupId.value } }));
}
</script>

<template>
  <div class="px-4 md:px-8 pb-6">
    <!-- 标题"「群名」的回收站(数量)" + 返回按钮 全走 TopBar (TopBar.vue 加 group-trash 路由专属返回按钮).
         view 内不再有标题行也不再有返回按钮 -->

    <!-- toolbar 同 Trash.vue 风格. 仅 owner 才显示"清空" 和 "批量永久删除". -->
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
          <button v-if="isOwner" @click="confirmBatchDelete = true" :disabled="!selectedIds.size"
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
          <button v-if="isOwner" @click="confirmEmpty = true" class="px-3 py-1 text-xs rounded-lg font-medium bg-red-50 text-red-500 hover:bg-red-100 transition-colors">
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
      <div v-if="allNotes.length === 0" class="text-center py-16">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhTrash size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">群回收站是空的</p>
        <p class="text-gray-400 text-xs mt-1">管理员删除的内容会在这里保留 {{ retentionDays }} 天</p>
      </div>
      <div v-else-if="notes.length === 0" class="text-center py-16">
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
                <span v-if="n.authorNickname && n.userId !== auth.user?.id" class="text-[11px] text-gray-400">
                  @{{ n.authorNickname }}
                </span>
                <span
                  class="ml-auto text-[11px] cursor-default transition-colors"
                  :class="hoveredId === n.id && daysLeftTooltip(n) ? 'text-red-400' : 'text-gray-400'"
                  @mouseenter="hoveredId = n.id"
                  @mouseleave="hoveredId = null"
                >
                  {{ hoveredId === n.id && daysLeftTooltip(n) ? daysLeftTooltip(n) : deletedInfo(n) }}
                </span>
              </div>
              <div class="text-gray-500 note-content">
                <div class="vditor-reset line-clamp-4" v-html="renderContentHl(n.id, n.content)" />
              </div>
              <div v-if="n.tags && (n.tags as string[]).length > 0" class="flex flex-wrap gap-1.5 mt-2">
                <span v-for="tag in (n.tags as string[])" :key="tag" class="text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full"
                  v-html="'#' + highlightText(tag)" />
              </div>
            </div>
            <div v-if="!selectMode" class="flex items-center gap-1 px-3 py-2 border-t border-gray-50 opacity-0 group-hover:opacity-100 transition-opacity">
              <button @click.stop="confirmRestoreId = n.id" class="px-3 py-1 text-xs bg-primary-light text-primary-dark hover:opacity-80 rounded-lg transition-colors">
                恢复
              </button>
              <button v-if="isOwner" @click.stop="confirmDeleteId = n.id" class="px-3 py-1 text-xs ml-auto rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors">
                永久删除
              </button>
            </div>
          </div>
        </TransitionGroup>
      </div>
    </template>
  </div>

  <!-- 永久删除确认 (仅 owner 能触发) -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmDeleteId" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmDeleteId = ''" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 text-center">
          <p class="text-sm text-gray-700 mb-1">永久删除</p>
          <p class="text-xs text-gray-400 mb-4">此操作不可恢复, 笔记内容跟所有关联数据 (评论 / 表情 / 提醒) 都将彻底清除</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmDeleteId = ''" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doPermanentDelete" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">永久删除</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 清空回收站确认 (仅 owner) -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmEmpty" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmEmpty = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">清空群回收站</p>
          <p class="text-xs text-gray-400 mb-4">将永久删除全部 {{ allNotes.length }} 条内容, 不可恢复</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmEmpty = false" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doEmptyAll" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">清空</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 恢复确认 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmRestoreId" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmRestoreId = ''" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">恢复内容</p>
          <p class="text-xs text-gray-400 mb-4">将从群回收站恢复此条内容, 重新回到群 feed + 原作者主 view</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmRestoreId = ''" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doRestore" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium transition-colors" style="background: rgb(var(--c-accent))">恢复</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 恢复所有 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmRestoreAll" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmRestoreAll = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">恢复所有</p>
          <p class="text-xs text-gray-400 mb-4">将恢复群回收站全部 {{ allNotes.length }} 条内容</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmRestoreAll = false" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doRestoreAll" class="inline-flex items-center justify-center px-4 py-1.5 text-xs rounded-lg text-white font-medium transition-colors" style="background: rgb(var(--c-accent))">恢复所有</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 批量恢复 -->
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

  <!-- 批量永久删除 (仅 owner) -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmBatchDelete" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmBatchDelete = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">批量永久删除</p>
          <p class="text-xs text-gray-400 mb-4">将永久删除选中的 {{ selectedIds.size }} 条内容, 不可恢复</p>
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
