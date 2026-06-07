<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, markRaw } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useNotesStore } from '@/stores/notes';
import { useGroupsStore } from '@/stores/groups';
import { useNotificationsStore } from '@/stores/notifications';
import { api, isLoggedIn, type Category } from '@/api';
import { useEscToClose } from '@/composables/useEscToClose';
import { useToast } from '@/composables/useToast';
import { dragState } from '@/utils/cardDnd';
import { resolveFileUrl, resolveFileThumbUrl, thumbErrorFallback } from '@/utils/fileUrl';
import { tasks as transferTasks, dockVisible as transferDockVisible } from '@/composables/useAttachmentTasks';
import { useSseSync } from '@/utils/sseSync';
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
  PhCaretLeft,
  PhCaretRight,
  PhGear,
  PhSignOut,
  PhArrowsDownUp,
  PhUsersThree,
  PhBell,
} from '@phosphor-icons/vue';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const notesStore = useNotesStore();
const groupsStore = useGroupsStore();
const notificationsStore = useNotificationsStore();

// Sidebar 整体折叠: w-60 → w-14. 折叠后只显示图标 + 红点角标, 隐藏分类区/拖拽 handle
const SIDEBAR_COLLAPSED_KEY = 'quink_sidebar_collapsed';
const sidebarCollapsed = ref(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
watch(sidebarCollapsed, (v) => { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0'); });
// 收起按钮: 只在 hover 椭圆位置 200ms 后才显示 (防鼠标划过即触发太碍眼)
const collapseBtnShow = ref(false);
let collapseHoverTimer: ReturnType<typeof setTimeout> | null = null;
function onCollapseEnter() {
  if (collapseHoverTimer) clearTimeout(collapseHoverTimer);
  collapseHoverTimer = setTimeout(() => { collapseBtnShow.value = true; }, 200);
}
function onCollapseLeave() {
  if (collapseHoverTimer) { clearTimeout(collapseHoverTimer); collapseHoverTimer = null; }
  collapseBtnShow.value = false;
}
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
if (isLoggedIn()) groupsStore.loadGroups().catch(() => {});
// 多设备 SSE 同步: 其他设备改了分类 → sidebar 自动 reload categories
useSseSync('categories', loadCategories);
// loadStats 是数据库聚合查询. store.notes 变化时同步刷新, 但 debounce 500ms 避免高频触发:
// loadMore push 多次 / pollNoteAiResult 字段 mutate / 切 view 时 computed 返回新数组引用 等场景
// 都会触发 watch, 没 debounce 一次操作就会产生 5+ 个 API 请求.
let statsTimer: number | undefined;
function scheduleLoadStats() {
  if (statsTimer !== undefined) clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => loadStats(), 500);
}
watch(() => notesStore.notes, scheduleLoadStats, { deep: true });
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
  // 只在非内容页时跳灵感,灵感/笔记/待办页原地筛选 (PR #8: 灵感 / → /quink)
  const contentPaths = ['/quink', '/notes', '/todos'];
  if (!contentPaths.includes(route.path)) {
    router.push('/quink');
  }
}

// dropType 标记: 前 3 项 = "拖到此处改 type"; AI 用 dropAction='ai' (拖到 AI 项 = 跳 /ai 新对话 / 停留 1s 自动展开)
// PR #8: dropType 字段值跟新命名对齐 (quink=灵感, note=笔记, todo=待办)
const mainNav: Array<{ path: string; label: string; icon: any; dropType?: 'quink' | 'note' | 'todo'; dropAction?: 'ai' }> = [
  { path: '/quink', label: '灵感', icon: markRaw(PhLightbulb), dropType: 'quink' },
  { path: '/notes', label: '笔记', icon: markRaw(PhNotePencil), dropType: 'note' },
  { path: '/todos', label: '待办', icon: markRaw(PhCheckSquare), dropType: 'todo' },
  { path: '/ai', label: 'AI', icon: markRaw(PhSparkle), dropAction: 'ai' },
  { path: '/groups', label: '群组', icon: markRaw(PhUsersThree) },
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
  if (notesStore.selectMode) notesStore.exitSelectMode();
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

function isActive(path: string) {
  // /groups 项要在 /groups + /groups/:id 都高亮 (左侧群列表内切群时 sidebar 保持高亮)
  if (path === '/groups') return route.path === '/groups' || route.path.startsWith('/groups/');
  return route.path === path;
}
function toggleUserMenu() { showUserMenu.value = !showUserMenu.value; }
function closeUserMenu() { showUserMenu.value = false; }
function goSettings() { closeUserMenu(); router.push('/settings'); }
function handleLogout() { closeUserMenu(); auth.logout(); router.push('/login'); }

// 头像菜单里的"传输列表"入口: 仅有任务时显示菜单项(跟 dock v-if 一致), badge 显示进行中数量.
// 点击 = 强制 dockVisible=true 把已 dismiss 的 dock 拉回来, 用户能继续看进度 / 已完成结果.
const transferDownloadingCount = computed(() =>
  transferTasks.value.filter((t) => t.status === 'downloading').length
);
function openTransferDock() {
  closeUserMenu();
  transferDockVisible.value = true;
}

// PR #10 通知中心入口: 头像菜单"传输列表"上方. badge 显示未读总数 (按 store.unread.total).
// 未读数靠 onMounted 首次 + SSE notification-new 实时更新; 这里不主动 setInterval
function openNotifications() {
  closeUserMenu();
  router.push('/notifications');
}
function getInitial(name: string) { return name ? name.charAt(0).toUpperCase() : '?'; }

// 拖到回收站时 cardDnd 派 quink-drop-trash 事件, Sidebar 这里弹确认 modal (避开把 confirm UI 塞 utils/)
function onDropTrashEvent(e: CustomEvent) {
  const ids = e.detail as string[];
  if (!ids?.length) return;
  trashIds.value = ids;
  confirmTrash.value = true;
}
// 拖动停留 sidebar 主导航项 (灵感/笔记/待办/AI) 400ms → cardDnd 派 quink-ai-expand (event 名历史遗留, 见 cardDnd.ts)
// → 这里 navigate 到 detail.path 但拖动状态不释放, 用户能继续拖目标视图 (e.g. AI 的 conv 列表) 或松手 commit type 变更
function onAiExpand(e: Event) {
  const path = (e as CustomEvent).detail?.path ?? '/ai';  // detail 缺省兜底 /ai 兼容旧调用
  if (route.path !== path) router.push(path);
}

// 分类区高度拖拽. 蘑菇规则:
//   - nav (上半部分入口) 全程完整显示, 不允许被压缩
//   - nav 跟 handle 之间是 spacer (间隙), 拖 handle 上移让 spacer 缩
//   - spacer = 0 时 handle 不能再上 (nav 不允许被压挤)
//   - 拖 handle 下移让分类区缩, 但 min 保证至少 1 行分类显示
const CATEGORY_HEIGHT_KEY = 'quink_sidebar_category_height';
// 分类区下方固定区域 (handle 6 + 分类标题块 padding+内容约 36) 留出的高度
const CATEGORY_FIXED_OVERHEAD = 42;
// 分类区最小高度: 至少显示一行分类项. 一行分类 = py-1.5 (12px) + line-height ~14 + text-xs ≈ 26-28
const CATEGORY_MIN_H = 28;
const categoryHeight = ref(160);
const sidebarEl = ref<HTMLElement | null>(null);
const userBlockEl = ref<HTMLElement | null>(null);
const navEl = ref<HTMLElement | null>(null);
let resizeStartY = 0;
let resizeStartH = 0;
let sidebarRO: ResizeObserver | null = null;
// 算分类区允许的最大高度: viewport - sidebar.top - userH - navH (nav 全显示需要的高度) - 固定区.
// nav 用 scrollHeight 拿"自然高度" (即使被 flex 容器压缩, scrollHeight 仍是完整内容高度).
function getMaxCategoryHeight(): number {
  if (!sidebarEl.value) return 800;
  const sidebarTop = sidebarEl.value.getBoundingClientRect().top;
  const availH = window.innerHeight - sidebarTop;
  const userH = userBlockEl.value?.offsetHeight || 0;
  const navH = navEl.value?.scrollHeight || 0;
  return Math.max(CATEGORY_MIN_H, availH - userH - navH - CATEGORY_FIXED_OVERHEAD);
}
function onCategoryResizeStart(e: PointerEvent) {
  e.preventDefault();
  resizeStartY = e.clientY;
  resizeStartH = categoryHeight.value;
  // 用 var() 配 Bibata 主题色 cursor，fallback 系统 row-resize
  document.body.style.cursor = 'var(--cur-row-resize), row-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', onCategoryResizeMove);
  window.addEventListener('pointerup', onCategoryResizeEnd, { once: true });
}
function onCategoryResizeMove(e: PointerEvent) {
  // 向上拖 (clientY 减小) → 分类区变高
  const delta = resizeStartY - e.clientY;
  // dynamic max = spacer 用完时的极限 (nav 不允许压缩);
  // dynamic min = CATEGORY_MIN_H (至少 1 行).
  const dynamicMax = getMaxCategoryHeight();
  categoryHeight.value = Math.max(CATEGORY_MIN_H, Math.min(dynamicMax, resizeStartH + delta));
}
function onCategoryResizeEnd() {
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  window.removeEventListener('pointermove', onCategoryResizeMove);
  try { localStorage.setItem(CATEGORY_HEIGHT_KEY, String(categoryHeight.value)); } catch {}
}

onMounted(() => {
  window.addEventListener('quink-drop-trash', onDropTrashEvent as EventListener);
  window.addEventListener('quink-ai-expand', onAiExpand);
  // 首次拉未读数 (启动时徽章正确). 后续 SSE notification-new 自动 +1, 不需要 polling
  if (isLoggedIn()) notificationsStore.loadUnreadCount().catch(() => {});
  try {
    const saved = Number(localStorage.getItem(CATEGORY_HEIGHT_KEY));
    if (saved >= CATEGORY_MIN_H && saved <= 800) categoryHeight.value = saved;
  } catch {}
  // ResizeObserver 监听 sidebar 真实大小, layout 稳定 + 窗口缩放都触发 clamp.
  // 之前用 nextTick 只触发一次, 但 Vue nextTick 是 microtask 在 flex 布局之前 → sidebar.clientHeight
  // 拿到 0 或半成品值 → dynamicMax 算错 → 把 categoryHeight clamp 到不合理的小值 (蘑菇报: 拖了无效,
  // 列表内容滚不到 — 因为 maxHeight 被错误 clamp 到 40 卡死).
  // ResizeObserver 等真正 layout 完成才 fire, 而且窗口缩放时也持续 clamp.
  if (sidebarEl.value) {
    sidebarRO = new ResizeObserver(() => {
      const maxH = getMaxCategoryHeight();
      if (categoryHeight.value > maxH) categoryHeight.value = maxH;
    });
    sidebarRO.observe(sidebarEl.value);
  }
});
onUnmounted(() => {
  window.removeEventListener('quink-drop-trash', onDropTrashEvent as EventListener);
  window.removeEventListener('quink-ai-expand', onAiExpand);
  sidebarRO?.disconnect();
});
</script>

<template>
  <aside ref="sidebarEl"
    class="relative bg-sidebar flex flex-col min-h-full max-h-full shrink-0 overflow-visible transition-[width] duration-200"
    :class="sidebarCollapsed ? 'w-14' : 'w-60'"
    style="border-right: 1px solid var(--sb-border); box-shadow: 1px 0 4px rgba(0,0,0,0.04)">
    <!-- 收起按钮: wrapper 包 button 接所有 hover (避免 sibling 间 mouseenter/mouseleave race 导致闪烁 / 200ms timer 被 clear 后不显示).
         wrapper -right-1.5 + w-7 = 28px hit area, 浮出 sidebar 右边 6px 把 button 浮出部分也包进去.
         button 自己不再接 hover, mouseenter/leave 不冒泡, sibling-race 不存在. -->
    <div class="absolute -right-1.5 top-1/2 -translate-y-1/2 z-20 w-7 h-32"
      @mouseenter="onCollapseEnter"
      @mouseleave="onCollapseLeave">
      <button @click="sidebarCollapsed = !sidebarCollapsed"
        class="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-24 rounded-full flex items-center justify-center transition-opacity duration-150"
        :class="collapseBtnShow ? 'opacity-100' : 'opacity-0 pointer-events-none'"
        style="background: var(--sb-dim); color: var(--c-sidebar)"
        :title="sidebarCollapsed ? '展开侧栏' : '收起侧栏'">
        <PhCaretLeft v-if="!sidebarCollapsed" size="0.5rem" weight="bold" />
        <PhCaretRight v-else size="0.5rem" weight="bold" />
      </button>
    </div>
    <!-- User: 展开态正常布局, 折叠态头像居中. 头像 28px (w-7), 折叠态 padding 必须给头像留够空间
         (sidebar w-14=56, 头像 28, 不能让 user block + button padding 累计 >= 28). 折叠态 px-1.5/p-1 -->
    <div ref="userBlockEl" class="relative py-3"
      :class="sidebarCollapsed ? 'px-1.5' : 'px-3'"
      style="border-bottom: 1px solid var(--sb-border)">
      <button @click="toggleUserMenu"
        class="flex items-center w-full rounded-xl transition-colors text-left"
        :class="sidebarCollapsed ? 'justify-center p-1' : 'gap-3 px-3 py-2'"
        style="color: var(--sb-text)" @mouseenter="($event.currentTarget as HTMLElement).style.background = 'var(--sb-hover)'" @mouseleave="($event.currentTarget as HTMLElement).style.background = 'transparent'">
        <!-- <img> 走 thumb URL; @error 一次性降级原图. 比 background-image 路径 downsample 质量好 -->
        <img v-if="auth.avatar" :src="resolveFileThumbUrl(auth.avatar)"
          @error="thumbErrorFallback($event, resolveFileUrl(auth.avatar))"
          draggable="false" alt="头像"
          class="w-7 h-7 rounded-full object-cover shrink-0 aspect-square" />
        <div v-else class="w-7 h-7 rounded-full bg-primary/30 text-primary flex items-center justify-center text-sm font-bold shrink-0">
          {{ getInitial(auth.nickname) }}
        </div>
        <div v-if="!sidebarCollapsed" class="flex-1 min-w-0">
          <div class="text-sm font-medium truncate" style="color: var(--sb-text)">{{ auth.nickname || '未设置' }}</div>
          <div class="text-xs truncate" style="color: var(--sb-dim)">@{{ auth.user?.username }}</div>
        </div>
        <PhCaretDown v-if="!sidebarCollapsed" size="1rem" weight="fill" class="shrink-0 transition-transform" :class="{ 'rotate-180': showUserMenu }" style="color: var(--sb-dim)" />
      </button>

      <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
        enter-to-class="opacity-100 scale-100" leave-active-class="transition duration-75 ease-in"
        leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
        <div v-if="showUserMenu"
          class="absolute bg-sidebar-light rounded-xl shadow-xl z-[var(--z-sidebar)] py-1"
          :class="sidebarCollapsed ? 'left-full ml-1 top-3 w-44' : 'left-3 right-3 top-full mt-1'"
          style="border: 1px solid var(--sb-border)">
          <!-- PR #10 消息通知: 常驻入口. badge 显示 store.unread.total. 点击跳 /notifications -->
          <button @click="openNotifications"
            class="w-full flex items-center gap-2 px-4 py-2.5 text-sm transition-colors"
            style="color: var(--sb-text)"
            @mouseenter="($event.currentTarget as HTMLElement).style.background = 'var(--sb-hover)'"
            @mouseleave="($event.currentTarget as HTMLElement).style.background = 'transparent'">
            <PhBell size="1rem" weight="fill" /><span>消息通知</span>
            <!-- badge 样式复用待办那套 (蘑菇 2026-06-08 之前精调过 padding/字号/颜色) -->
            <span v-if="notificationsStore.unread.total > 0"
              class="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] pb-[1px] bg-red-400/70 text-white text-[11px] leading-none font-semibold tabular-nums rounded-full"
              :class="String(notificationsStore.unread.total > 99 ? '99+' : notificationsStore.unread.total).length > 1 ? 'pl-[3.5px] pr-[4.5px]' : 'px-1'">
              {{ notificationsStore.unread.total > 99 ? '99+' : notificationsStore.unread.total }}
            </span>
          </button>
          <div style="border-top: 1px solid var(--sb-border); margin: 4px 0"></div>
          <!-- 传输列表: 常驻入口, 永远可点. 无任务时点开 dock 显示空状态 -->
          <button @click="openTransferDock"
            class="w-full flex items-center gap-2 px-4 py-2.5 text-sm transition-colors"
            style="color: var(--sb-text)"
            @mouseenter="($event.currentTarget as HTMLElement).style.background = 'var(--sb-hover)'"
            @mouseleave="($event.currentTarget as HTMLElement).style.background = 'transparent'">
            <PhArrowsDownUp size="1rem" weight="fill" /><span>传输列表</span>
            <span v-if="transferDownloadingCount > 0"
              class="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-medium rounded-full bg-primary text-white tabular-nums">
              {{ transferDownloadingCount }}
            </span>
          </button>
          <div style="border-top: 1px solid var(--sb-border); margin: 4px 0"></div>
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

    <!-- Nav: 自然高度全显示 (shrink-0 不压缩 + 无 overflow-y). 蘑菇规则: nav 所有入口必须始终可见,
         不允许被分类区拖大时压缩 / 内部滚动. spacer 跟分类区的 height 互补占满剩余空间.
         折叠态 icon-only + 居中 + label 隐藏 + 角标改右上角小红点 -->
    <nav ref="navEl" class="shrink-0 py-3 space-y-0.5" :class="sidebarCollapsed ? 'px-2' : 'px-3'">
      <!-- Main nav (前 3 项有 dropType: 拖卡片到此改 type); 拖动状态机 (cardDnd) 通过 [data-drop-target] 属性识别 -->
      <router-link v-for="item in mainNav" :key="item.path" :to="item.path"
        :data-nav-path="item.path"
        :data-drop-target="item.dropType ? 'type:' + item.dropType : item.dropAction ? 'action:' + item.dropAction : undefined"
        :title="sidebarCollapsed ? item.label : ''"
        class="relative flex items-center rounded-xl text-sm transition-all duration-150 nav-item"
        :class="[
          sidebarCollapsed ? 'justify-center p-2' : 'gap-3 px-3 py-2',
          (item.dropType && isActiveDrop('type:' + item.dropType)) || (item.dropAction && isActiveDrop('action:' + item.dropAction)) ? 'drop-target-active' : '',
        ]"
        :style="isActive(item.path)
          ? { background: 'var(--sb-active-bg)', color: 'var(--sb-active-text)', fontWeight: 500 }
          : { color: 'var(--sb-dim)' }">
        <component :is="item.icon" size="1.125rem" weight="fill" />
        <span v-if="!sidebarCollapsed">{{ item.label }}</span>
        <!-- 展开态: 待办数字角标
             视觉居中坑 (2 段):
             1. 纵向: leading-none + items-center 几何居中后, 字体 glyph 在 em-square 里不在几何中心
                (无衬线字体数字偏上侧, baseline 偏下), 视觉上数字看着"靠下". pb-[1px] 把 flex 内容往上推 1px 抵消.
                translate-y-[1px] 整体下移 1px 让圆点跟"待办"文字 baseline 视觉对齐 (icon size 1.125rem 比 text 14px 略高).
             2. 横向 (2 位数+): "1" 在 em-square 里 ink 偏右半 (左边大段空白让 "1" 看着窄), "10"/"99+" 等多位数视觉重心偏右,
                技术上 padding 完全对称但视觉看着"左空多右空少". 1 位数 (1-9) "0/2/3..." 字符本身对称, 不调.
                多位数用 pl-[3.5px] pr-[4.5px] 让内容向左挤 0.5px sub-pixel (蘑菇 2026-06-08 在 badge-test.html 6 方案对比定稿: 整 1px 偏左过头, 0.5px 半步刚好).
                注: zoom=1.5 时 0.5 CSS px = 0.75 物理像素, 浏览器 sub-pixel antialiasing 渲染. zoom=1 时 0.5px round 但 letter glyph 仍能感知微偏 -->
        <span v-if="!sidebarCollapsed && item.label === '待办' && stats.pendingTodos > 0 && auth.user?.preferences?.showTodoBadge !== false"
          class="ml-auto translate-y-[1px] inline-flex items-center justify-center min-w-[18px] h-[18px] pb-[1px] bg-red-400/70 text-white text-[11px] leading-none font-semibold tabular-nums rounded-full"
          :class="String(stats.pendingTodos > 99 ? '99+' : stats.pendingTodos).length > 1 ? 'pl-[3.5px] pr-[4.5px]' : 'px-1'">
          {{ stats.pendingTodos > 99 ? '99+' : stats.pendingTodos }}
        </span>
        <!-- 折叠态: 小红点 (统一暗红跟群组列表折叠态视觉一致) -->
        <span v-else-if="sidebarCollapsed && item.label === '待办' && stats.pendingTodos > 0 && auth.user?.preferences?.showTodoBadge !== false"
          class="absolute top-1 right-1 w-2 h-2 bg-red-400/90 rounded-full" />
        <!-- 群组项折叠态: 总 pending 角标 → 小红点 -->
        <span v-if="sidebarCollapsed && item.label === '群组' && groupsStore.totalPendingCount > 0"
          class="absolute top-1 right-1 w-2 h-2 bg-red-400/90 rounded-full" />
      </router-link>

      <!-- More (其中"回收站"接受 drop = 软删除, 任何 type/单选多选都可拖入) -->
      <router-link v-for="item in moreNav" :key="item.path" :to="item.path"
        :data-drop-target="item.dropAction ? 'action:' + item.dropAction : undefined"
        :title="sidebarCollapsed ? item.label : ''"
        class="flex items-center rounded-xl text-sm transition-all duration-150 nav-item"
        :class="[
          sidebarCollapsed ? 'justify-center p-2' : 'gap-3 px-3 py-2',
          item.dropAction && isActiveDrop('action:' + item.dropAction) ? 'drop-target-active' : '',
        ]"
        :style="isActive(item.path)
          ? { background: 'var(--sb-active-bg)', color: 'var(--sb-active-text)', fontWeight: 500 }
          : { color: 'var(--sb-dim)' }">
        <component :is="item.icon" size="1.125rem" weight="fill" />
        <span v-if="!sidebarCollapsed">{{ item.label }}</span>
      </router-link>
    </nav>

    <!-- Spacer: 占 nav 跟 handle 之间的间隙. 用户拖 handle 上 → spacer 缩 (handle 上移逼近 nav 底部);
         spacer = 0 时 dynamic max 阻止再上拖 (nav 必须完整显示, 不允许压挤). -->
    <div class="flex-1"></div>

    <!-- Categories: 折叠态完全隐藏 (用户切回展开态再看) -->
    <div v-if="!sidebarCollapsed" class="category-resize-handle"
      @pointerdown="onCategoryResizeStart"
      title="拖动调整分类区高度" />
    <div v-if="!sidebarCollapsed" class="px-3 py-2 shrink-0">
      <div class="flex items-center justify-between px-3 mb-1">
        <span class="text-[11px] font-medium" style="color: var(--sb-dim)">分类</span>
        <button @click="showAddCategory = true" class="text-xs" style="color: var(--sb-dim)" title="新增分类">+</button>
      </div>
      <!-- Tree -->
      <div v-if="categories.length === 0 && !showAddCategory" class="px-3 py-2">
        <span class="text-[11px]" style="color: var(--sb-dim); opacity: 0.5">暂无分类</span>
      </div>
      <div v-else class="space-y-0.5 overflow-y-auto"
        :style="{ height: categoryHeight + 'px' }">
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
    <div v-if="showUserMenu" class="fixed inset-0 z-[var(--z-sidebar-backdrop)]" @click="closeUserMenu" />

    <!-- 添加分类弹窗 -->
    <Transition name="modal">
      <div v-if="showAddCategory" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="showAddCategory = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72">
          <p class="text-sm font-medium text-gray-700 mb-3">新增分类</p>
          <input v-model="newCategoryName" @keydown.enter="addCategory" placeholder="输入分类名称" autofocus
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40" />
          <div class="flex gap-2 mt-4 justify-end">
            <button @click="showAddCategory = false; newCategoryName = ''"
              class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="addCategory"
              class="px-4 py-1.5 text-xs rounded-lg text-white font-medium"
              style="background: rgb(var(--c-accent-dark))">添加</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 拖到回收站确认弹窗 (跟其他删除路径一致, 危险操作必须确认) -->
    <Transition name="modal">
      <div v-if="confirmTrash" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="cancelTrash" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">删除内容</p>
          <p class="text-xs text-gray-400 mb-4">将 {{ trashIds.length }} 条内容移至回收站</p>
          <div class="flex gap-2 justify-center">
            <button @click="cancelTrash" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doTrash" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 删除分类确认弹窗 -->
    <Transition name="modal">
      <div v-if="showDeleteConfirm" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="showDeleteConfirm = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">确认删除分类</p>
          <p class="text-xs text-gray-400 mb-4">「{{ deletingCategoryName }}」及关联笔记的分类将被清除</p>
          <div class="flex gap-2 justify-center">
            <button @click="showDeleteConfirm = false"
              class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="deleteCategory(deletingCategoryId!)"
              class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
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
/* 分类区拖拽 handle: 6px 高 + 默认 cursor: row-resize 让鼠标一进来就知道可拖.
   ::before 一根 2px 横线作 default 视觉 (比原 1px sb-border 明显, 用户能看出"这里是分隔可拖区"),
   hover 时变 3px + 半透明主题色加深做视觉反馈. touch-action:none 防移动端误触发滚动. */
.category-resize-handle {
  height: 6px;
  position: relative;
  cursor: var(--cur-row-resize), row-resize;
  touch-action: none;
}
.category-resize-handle::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 2px;
  background: var(--sb-border);
  transition: background 0.15s ease, height 0.15s ease;
}
.category-resize-handle:hover::before {
  height: 3px;
  background: rgb(var(--c-accent) / 0.4);
}
</style>
