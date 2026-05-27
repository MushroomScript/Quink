<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, markRaw } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useNotesStore } from '@/stores/notes';
import { api, isLoggedIn, type Category } from '@/api';
import { useEscToClose } from '@/composables/useEscToClose';
import { useToast } from '@/composables/useToast';
import { dragState } from '@/utils/cardDnd';
import {
  PhLightbulb,
  PhNotePencil,
  PhCheckSquare,
  PhSparkle,
  PhChartBar,
  PhFolder,
  PhTag,
  PhTrash,
  PhFolderOpen,
  PhFile,
  PhCaretDown,
  PhGear,
  PhSignOut,
} from '@phosphor-icons/vue';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const notesStore = useNotesStore();
const toast = useToast();
const stats = ref({ totalNotes: 0, totalTodos: 0, pendingTodos: 0 });
const showUserMenu = ref(false);
const categories = ref<Category[]>([]);
const showAddCategory = ref(false);
const newCategoryName = ref('');
const activeCategory = ref('');
const showDeleteConfirm = ref(false);
const deletingCategoryId = ref<number | null>(null);
const deletingCategoryName = ref('');

async function loadStats() {
  if (!isLoggedIn()) return;
  try { const res = await api.getStats(); stats.value = res.data; } catch {}
}
async function loadCategories() {
  if (!isLoggedIn()) return;
  try { const res = await api.getCategories(); categories.value = res.data; } catch {}
}
loadStats();
loadCategories();
watch(() => notesStore.notes, () => { loadStats(); }, { deep: true });
watch(() => notesStore.filterCategory, (v) => { activeCategory.value = v; });

async function addCategory() {
  const name = newCategoryName.value.trim();
  if (!name) return;
  try {
    await api.createCategory({ name });
    newCategoryName.value = '';
    showAddCategory.value = false;
    await loadCategories();
  } catch {}
}

async function deleteCategory(id: number) {
  try {
    await api.deleteCategory(id);
    await loadCategories();
    if (activeCategory.value === deletingCategoryName.value) {
      activeCategory.value = '';
      notesStore.filterCategory = '';
      notesStore.fetchNotes();
    }
  } catch {}
  showDeleteConfirm.value = false;
  deletingCategoryId.value = null;
  deletingCategoryName.value = '';
}

function confirmDelete(cat: any) {
  deletingCategoryId.value = cat.id;
  deletingCategoryName.value = cat.name;
  showDeleteConfirm.value = true;
}

function filterByCategory(name: string) {
  if (activeCategory.value === name) {
    activeCategory.value = '';
    notesStore.filterCategory = '';
  } else {
    activeCategory.value = name;
    notesStore.filterCategory = name;
  }
  notesStore.fetchNotes();
  // 只在非内容页时跳灵感,灵感/笔记/待办页原地筛选
  const contentPaths = ['/', '/notes', '/todos'];
  if (!contentPaths.includes(route.path)) {
    router.push('/');
  }
}

// dropType 标记: 前 3 项 = "拖到此处改 type"; AI 用 dropAction='ai' (拖到 AI 项 = 跳 /ai 新对话 / 停留 1s 自动展开)
const mainNav: Array<{ path: string; label: string; icon: any; dropType?: 'note' | 'snippet' | 'todo'; dropAction?: 'ai' }> = [
  { path: '/', label: '灵感', icon: markRaw(PhLightbulb), dropType: 'note' },
  { path: '/notes', label: '笔记', icon: markRaw(PhNotePencil), dropType: 'snippet' },
  { path: '/todos', label: '待办', icon: markRaw(PhCheckSquare), dropType: 'todo' },
  { path: '/ai', label: 'AI', icon: markRaw(PhSparkle), dropAction: 'ai' },
];
// moreNav 里只有"回收站"接受 drop (= 软删除); 其他 (统计/资源/标签) 不接受
const moreNav: Array<{ path: string; label: string; icon: any; dropAction?: 'trash' }> = [
  { path: '/stats', label: '统计', icon: markRaw(PhChartBar) },
  { path: '/resources', label: '资源', icon: markRaw(PhFolder) },
  { path: '/tags', label: '标签', icon: markRaw(PhTag) },
  { path: '/trash', label: '回收站', icon: markRaw(PhTrash), dropAction: 'trash' },
];

// 拖动到 sidebar 的 drop target 视觉/落地: 用 cardDnd 的 reactive state (cardDnd.ts 自己处理 pointer events 完成 update),
// Sidebar 只负责暴露 [data-drop-target] 属性 + drop-target-active class. 回收站走 quink-drop-trash 事件触发确认.
const confirmTrash = ref(false);
const trashIds = ref<string[]>([]);
useEscToClose(confirmTrash);
useEscToClose(showAddCategory);
useEscToClose(showDeleteConfirm);

function isActiveDrop(target: string): boolean {
  return dragState.active && dragState.hoverTarget === target;
}

async function doTrash() {
  // 先 snapshot, deleteNote 走 splice 后就找不到了
  const snapshots: typeof notesStore.notes[number][] = [];
  for (const id of trashIds.value) {
    const n = notesStore.notes.find((x) => x.id === id);
    if (n) snapshots.push({ ...n });
  }
  // Promise.all 并发 (跟 Trash 的 doRestoreAll / doBatchRestore 等批量操作风格统一)
  await Promise.all(trashIds.value.map(id => notesStore.deleteNote(id).catch(e => console.error('[doTrash]', id, e))));
  if (notesStore.selectMode) notesStore.clearSelection();
  trashIds.value = [];
  confirmTrash.value = false;
  if (snapshots.length === 0) return;
  toast.show(snapshots.length === 1 ? '已移到回收站' : `已移到回收站 ${snapshots.length} 条`, {
    duration: 5000,
    action: {
      label: '撤销',
      onClick: async () => {
        const n = await notesStore.undoDelete(snapshots);
        if (!n) toast.show('撤销失败', 'error');
      },
    },
  });
}

function cancelTrash() {
  trashIds.value = [];
  confirmTrash.value = false;
}

function isActive(path: string) { return route.path === path; }
function toggleUserMenu() { showUserMenu.value = !showUserMenu.value; }
function closeUserMenu() { showUserMenu.value = false; }
function goSettings() { closeUserMenu(); router.push('/settings'); }
function handleLogout() { closeUserMenu(); auth.logout(); router.push('/login'); }
function getInitial(name: string) { return name ? name.charAt(0).toUpperCase() : '?'; }

// 拖到回收站时 cardDnd 派 quink-drop-trash 事件, Sidebar 这里弹确认 modal (避开把 confirm UI 塞 utils/)
function onDropTrashEvent(e: CustomEvent) {
  const ids = e.detail as string[];
  if (!ids?.length) return;
  trashIds.value = ids;
  confirmTrash.value = true;
}
// 拖动停留 sidebar AI 项 1s → cardDnd 派 quink-ai-expand → 这里 navigate /ai 但拖动状态不释放, 用户能继续拖 conv 列表
function onAiExpand() {
  if (route.path !== '/ai') router.push('/ai');
}
onMounted(() => {
  window.addEventListener('quink-drop-trash', onDropTrashEvent as EventListener);
  window.addEventListener('quink-ai-expand', onAiExpand);
});
onUnmounted(() => {
  window.removeEventListener('quink-drop-trash', onDropTrashEvent as EventListener);
  window.removeEventListener('quink-ai-expand', onAiExpand);
});
</script>

<template>
  <aside class="w-60 bg-sidebar flex flex-col min-h-full shrink-0" style="border-right: 1px solid var(--sb-border); box-shadow: 1px 0 4px rgba(0,0,0,0.04)">
    <!-- User -->
    <div class="relative px-3 py-4" style="border-bottom: 1px solid var(--sb-border)">
      <button @click="toggleUserMenu"
        class="flex items-center gap-3 w-full rounded-xl px-3 py-2.5 transition-colors text-left"
        style="color: var(--sb-text)" @mouseenter="($event.currentTarget as HTMLElement).style.background = 'var(--sb-hover)'" @mouseleave="($event.currentTarget as HTMLElement).style.background = 'transparent'">
        <div v-if="auth.avatar" class="w-9 h-9 rounded-full bg-cover bg-center shrink-0" :style="{ backgroundImage: `url(${auth.avatar})` }" />
        <div v-else class="w-9 h-9 rounded-full bg-primary/30 text-primary flex items-center justify-center text-sm font-bold shrink-0">
          {{ getInitial(auth.nickname) }}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium truncate" style="color: var(--sb-text)">{{ auth.nickname || '未设置' }}</div>
          <div class="text-xs truncate" style="color: var(--sb-dim)">@{{ auth.user?.username }}</div>
        </div>
        <PhCaretDown size="1rem" weight="fill" class="shrink-0 transition-transform" :class="{ 'rotate-180': showUserMenu }" style="color: var(--sb-dim)" />
      </button>

      <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
        enter-to-class="opacity-100 scale-100" leave-active-class="transition duration-75 ease-in"
        leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
        <div v-if="showUserMenu" class="absolute left-3 right-3 top-full mt-1 bg-sidebar-light rounded-xl shadow-xl z-50 py-1" style="border: 1px solid var(--sb-border)">
          <button @click="goSettings" class="w-full flex items-center gap-2 px-4 py-2.5 text-sm transition-colors"
            style="color: var(--sb-text)" @mouseenter="($event.currentTarget as HTMLElement).style.background = 'var(--sb-hover)'" @mouseleave="($event.currentTarget as HTMLElement).style.background = 'transparent'">
            <PhGear size="1rem" weight="fill" /><span>设置</span>
          </button>
          <div style="border-top: 1px solid var(--sb-border); margin: 4px 0"></div>
          <button @click="handleLogout" class="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10">
            <PhSignOut size="1rem" weight="fill" /><span>注销</span>
          </button>
        </div>
      </Transition>
    </div>

    <!-- Nav -->
    <nav class="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
      <!-- Main nav (前 3 项有 dropType: 拖卡片到此改 type); 拖动状态机 (cardDnd) 通过 [data-drop-target] 属性识别 -->
      <router-link v-for="item in mainNav" :key="item.path" :to="item.path"
        :data-nav-path="item.path"
        :data-drop-target="item.dropType ? 'type:' + item.dropType : item.dropAction ? 'action:' + item.dropAction : undefined"
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all duration-150 nav-item"
        :class="{
          'drop-target-active': (item.dropType && isActiveDrop('type:' + item.dropType)) || (item.dropAction && isActiveDrop('action:' + item.dropAction))
        }"
        :style="isActive(item.path)
          ? { background: 'var(--sb-active-bg)', color: 'var(--sb-active-text)', fontWeight: 500 }
          : { color: 'var(--sb-dim)' }">
        <component :is="item.icon" size="1.125rem" weight="fill" />
        <span>{{ item.label }}</span>
        <span v-if="item.label === '待办' && stats.pendingTodos > 0 && auth.user?.preferences?.showTodoBadge !== false"
          class="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 bg-red-400/70 text-white text-[11px] leading-none font-semibold tabular-nums rounded-full">
          {{ stats.pendingTodos > 99 ? '99+' : stats.pendingTodos }}
        </span>
      </router-link>

      <!-- More (其中"回收站"接受 drop = 软删除, 任何 type/单选多选都可拖入) -->
      <router-link v-for="item in moreNav" :key="item.path" :to="item.path"
        :data-drop-target="item.dropAction ? 'action:' + item.dropAction : undefined"
        class="flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all duration-150 nav-item"
        :class="{ 'drop-target-active': item.dropAction && isActiveDrop('action:' + item.dropAction) }"
        :style="isActive(item.path)
          ? { background: 'var(--sb-active-bg)', color: 'var(--sb-active-text)', fontWeight: 500 }
          : { color: 'var(--sb-dim)' }">
        <component :is="item.icon" size="1.125rem" weight="fill" />
        <span>{{ item.label }}</span>
      </router-link>
    </nav>

    <!-- Categories -->
    <div class="px-3 py-2" style="border-top: 1px solid var(--sb-border)">
      <div class="flex items-center justify-between px-3 mb-1">
        <span class="text-[11px] font-medium" style="color: var(--sb-dim)">分类</span>
        <button @click="showAddCategory = true" class="text-xs" style="color: var(--sb-dim)" title="新增分类">+</button>
      </div>
      <!-- Tree -->
      <div v-if="categories.length === 0 && !showAddCategory" class="px-3 py-2">
        <span class="text-[11px]" style="color: var(--sb-dim); opacity: 0.5">暂无分类</span>
      </div>
      <div v-else class="space-y-0.5 max-h-40 overflow-y-auto">
        <div v-for="cat in categories" :key="cat.id"
          @click="filterByCategory(cat.name)"
          :data-drop-target="'cat:' + cat.name"
          class="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs cursor-pointer transition-all group"
          :class="{ 'drop-target-active': isActiveDrop('cat:' + cat.name) }"
          :style="activeCategory === cat.name
            ? { background: 'var(--sb-active-bg)', color: 'var(--sb-active-text)' }
            : { color: 'var(--sb-dim)' }">
          <PhFolderOpen size="0.875rem" weight="fill" />
          <span class="flex-1 truncate">{{ cat.name }}</span>
          <button @click.stop="confirmDelete(cat)" class="opacity-0 group-hover:opacity-100 text-[10px] hover:text-red-400" style="color: var(--sb-dim)">✕</button>
        </div>
        <template v-for="cat in categories" :key="'children-' + cat.id">
          <div v-for="child in cat.children" :key="child.id"
            @click="filterByCategory(child.name)"
            :data-drop-target="'cat:' + child.name"
            class="flex items-center gap-2 px-3 py-1.5 pl-8 rounded-lg text-xs cursor-pointer transition-all group"
            :class="{ 'drop-target-active': isActiveDrop('cat:' + child.name) }"
            :style="activeCategory === child.name
              ? { background: 'var(--sb-active-bg)', color: 'var(--sb-active-text)' }
              : { color: 'var(--sb-dim)' }">
            <PhFile size="0.875rem" weight="fill" />
            <span class="flex-1 truncate">{{ child.name }}</span>
            <button @click.stop="confirmDelete(child)" class="opacity-0 group-hover:opacity-100 text-[10px] hover:text-red-400" style="color: var(--sb-dim)">✕</button>
          </div>
        </template>
      </div>
    </div>

  </aside>

  <Teleport to="body">
    <div v-if="showUserMenu" class="fixed inset-0 z-40" @click="closeUserMenu" />

    <!-- 添加分类弹窗 -->
    <Transition name="modal">
      <div v-if="showAddCategory" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="showAddCategory = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72">
          <p class="text-sm font-medium text-gray-700 mb-3">新增分类</p>
          <input v-model="newCategoryName" @keydown.enter="addCategory" placeholder="输入分类名称" autofocus
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40" />
          <div class="flex gap-2 mt-4 justify-end">
            <button @click="showAddCategory = false; newCategoryName = ''"
              class="px-4 pt-[5.75px] pb-[7.75px] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="addCategory"
              class="px-4 pt-[5.75px] pb-[7.75px] text-xs rounded-lg text-white font-medium"
              style="background: rgb(var(--c-accent-dark))">添加</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 拖到回收站确认弹窗 (跟其他删除路径一致, 危险操作必须确认) -->
    <Transition name="modal">
      <div v-if="confirmTrash" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="cancelTrash" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">删除内容</p>
          <p class="text-xs text-gray-400 mb-4">将 {{ trashIds.length }} 条内容移至回收站</p>
          <div class="flex gap-2 justify-center">
            <button @click="cancelTrash" class="px-4 pt-[5.75px] pb-[7.75px] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doTrash" class="px-4 pt-[5.75px] pb-[7.75px] text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 删除分类确认弹窗 -->
    <Transition name="modal">
      <div v-if="showDeleteConfirm" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="showDeleteConfirm = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">确认删除分类</p>
          <p class="text-xs text-gray-400 mb-4">「{{ deletingCategoryName }}」及关联笔记的分类将被清除</p>
          <div class="flex gap-2 justify-center">
            <button @click="showDeleteConfirm = false"
              class="px-4 pt-[5.75px] pb-[7.75px] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="deleteCategory(deletingCategoryId!)"
              class="px-4 pt-[5.75px] pb-[7.75px] text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.nav-item:not(.router-link-active):hover {
  background: var(--sb-hover);
  color: var(--sb-text);
}
/* 拖动 NoteCard 到 sidebar 时 drop target 高亮: 虚线边框 + 背景色提示"可放下"
   dragover 是逐帧触发的, dragleave 不一定精确(子元素冒泡有时漏触发), dragOverTarget 用 id 去重避免视觉抖动 */
.drop-target-active {
  outline: 2px dashed rgb(var(--c-accent));
  outline-offset: -2px;
  background: rgba(var(--c-accent), 0.08) !important;
}
</style>
