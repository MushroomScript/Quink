<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, watchEffect, inject, type Ref } from 'vue';
import { useRoute } from 'vue-router';
import { useNotesStore } from '@/stores/notes';
import { useNotificationsStore } from '@/stores/notifications';
import { sharedPageCount as pageCount } from '@/composables/usePageCount';
import { api, type Category } from '@/api';
import { markRaw } from 'vue';
import { PhList, PhArrowsClockwise, PhMagnifyingGlass, PhXCircle, PhFunnel, PhLightbulb, PhNotePencil, PhCheckSquare, PhTag, PhFolderOpen, PhCalendarBlank, PhCheck, PhCaretRight } from '@phosphor-icons/vue';
import { pinyinMatch } from '@/utils/pinyin';
import { useToast } from '@/composables/useToast';
import DatePicker from '@/components/DatePicker.vue';
import { unzoomRect, unzoomViewport } from '@/utils/zoom';

const toggleMobileSidebar = inject<() => void>('toggleMobileSidebar');

const route = useRoute();
const store = useNotesStore();
const toast = useToast();
const categories = ref<Category[]>([]);
const showBatchMove = ref(false);
const batchMoveBtn = ref<HTMLElement>();
const batchMovePos = ref({ top: '0px', left: '0px' });

function toggleBatchMove() {
  showBatchMove.value = !showBatchMove.value;
  if (showBatchMove.value) {
    if (categories.value.length === 0) loadCategories();
    if (batchMoveBtn.value) {
      const r = unzoomRect(batchMoveBtn.value);
      const top = r.bottom + 4;
      const left = r.right - 160;
      batchMovePos.value = { top: top + 'px', left: left + 'px' };
    }
  }
}
const confirmBatchDelete = ref(false);

// 批量"移至类型" popover (灵感/笔记/待办, 复用 batchMove 的弹窗模式)
const showBatchType = ref(false);
const batchTypeBtn = ref<HTMLElement>();
const batchTypePos = ref({ top: '0px', left: '0px' });
function toggleBatchType() {
  showBatchType.value = !showBatchType.value;
  if (showBatchType.value && batchTypeBtn.value) {
    const r = unzoomRect(batchTypeBtn.value);
    batchTypePos.value = { top: (r.bottom + 4) + 'px', left: (r.right - 140) + 'px' };
  }
}
// PR #9: 批量操作 toast 含 skipped 提示 (群管理员多选含别人笔记时按权限筛, 失败的算 skipped)
function reportBatch(r: { ok: number; skipped: number }, verb: string) {
  if (r.skipped > 0) toast.show(`已${verb} ${r.ok} 条, 跳过 ${r.skipped} 条无权限`, 'default', 3500);
  else if (r.ok > 0) toast.show(`已${verb} ${r.ok} 条`, 'success', 2000);
}
async function pickBatchType(type: 'quink' | 'note' | 'todo') {
  showBatchType.value = false;
  const r = await store.batchUpdateType(type);
  reportBatch(r, '改类型');
}

// PR #9: 批量删除. 显示 toast (含 skipped)
async function doBatchDelete() {
  confirmBatchDelete.value = false;
  const r = await store.batchDelete();
  reportBatch(r, '删除');
}

// 待办页专属批量改 todoStatus: 已是目标状态的项静默跳过 (store 内过滤), toast 只报本次实际改动数
async function doBatchSetTodoStatus(status: 'done' | 'pending') {
  const n = await store.batchSetTodoStatus(status);
  toast.show(status === 'done' ? `已完成 ${n} 项` : `已标记未完成 ${n} 项`, 'success');
}

// 批量"加标签" popover (input + 现有标签建议下拉 + 已选 chip + 确认按钮)
const showBatchTags = ref(false);
const batchTagsBtn = ref<HTMLElement>();
const batchTagsPos = ref({ top: '0px', left: '0px' });
const batchTagInput = ref('');
const batchTagsSelected = ref<string[]>([]);
// 空输入显示所有未选标签 (容器 max-h-32 + overflow 滚动, 多标签也能浏览); 输入时 pinyin fuzzy 过滤前 20 条
const batchTagSuggestions = computed(() => {
  const q = batchTagInput.value.trim();
  const all = allTags.value.filter(t => !batchTagsSelected.value.includes(t));
  if (!q) return all;
  return all.filter(t => pinyinMatch(t, q)).slice(0, 20);
});
async function toggleBatchTags() {
  showBatchTags.value = !showBatchTags.value;
  if (showBatchTags.value) {
    if (allTags.value.length === 0) {
      try { const res = await api.getTags(); allTags.value = res.data; } catch (e) { console.error('[toggleBatchTags] getTags failed:', e); }
    }
    if (batchTagsBtn.value) {
      const r = unzoomRect(batchTagsBtn.value);
      batchTagsPos.value = { top: (r.bottom + 4) + 'px', left: (r.right - 240) + 'px' };
    }
  } else {
    batchTagInput.value = '';
    batchTagsSelected.value = [];
  }
}
function addBatchTag(t: string) {
  const tag = t.trim();
  if (!tag || batchTagsSelected.value.includes(tag)) return;
  batchTagsSelected.value.push(tag);
  batchTagInput.value = '';
}
function removeBatchTag(t: string) {
  batchTagsSelected.value = batchTagsSelected.value.filter(x => x !== t);
}
function onBatchTagInputEnter() {
  // 回车: 优先用建议第一项 (跟 sidebar 搜索栏 addTag 一致), 没有则用 input 字面值新建
  const first = batchTagSuggestions.value[0];
  if (first) addBatchTag(first);
  else if (batchTagInput.value.trim()) addBatchTag(batchTagInput.value);
}
async function confirmBatchTags() {
  if (!batchTagsSelected.value.length) return;
  // 先把状态快照(store.batchAddTags 内会 exitSelectMode 清空 selectedIds), 再 await; 失败时 console.error 不静默
  const tags = [...batchTagsSelected.value];
  showBatchTags.value = false;
  batchTagInput.value = '';
  batchTagsSelected.value = [];
  try {
    const r = await store.batchAddTags(tags);
    reportBatch(r, '加标签');
  } catch (e) {
    console.error('[batchAddTags] failed:', e);
  }
}
const searchInput = ref<HTMLInputElement>();
const searchBoxEl = ref<HTMLElement>();
const tagSuggestPos = ref({ top: '0px', left: '0px', width: '0px' });
const searchText = ref('');
const searchFocused = ref(false);
const showFilters = ref(false);
const showMobileSearch = ref(false);
const filterTags = ref<string[]>([]);
// filterTypes 默认跟当前 view 对应的类型走 (之前默认全选 3 个 → 用户输关键字搜出 3 类型,
// 但 view 自己又 filterType 过滤到单类型,看起来"全选了却没全搜"。现在默认值跟 view 对齐,所见即所得)
function getDefaultFilterTypes(): string[] {
  // PR #8 命名重整: /quink=灵感=quink, /notes=笔记=note, /todos=待办=todo
  if (route.path === '/notes') return ['note'];
  if (route.path === '/todos') return ['todo'];
  return ['quink'];
}
const filterTypes = ref<string[]>(getDefaultFilterTypes());
const filterDateFrom = ref('');
const filterDateTo = ref(new Date().toISOString().slice(0, 10));
const allTags = ref<string[]>([]);
let searchTimer: ReturnType<typeof setTimeout>;
const showTagSuggestions = ref(false);

watch(() => route.path, () => {
  clearTimeout(searchTimer);
  searchText.value = '';
  store.searchQuery = '';  // 切页清掉 store 里残留(资源/标签 view watch 它过滤,残留会让新页一进来就被过滤)
  filterTags.value = [];
  filterTypes.value = getDefaultFilterTypes();
  filterDateFrom.value = '';
  filterDateTo.value = new Date().toISOString().slice(0, 10);
  // 离开资源页时清掉 file 筛选(避免再回去带着上次的过滤)
  if (route.path !== '/resources') {
    store.fileCategory = 'all';
    store.fileDateFrom = '';
    store.fileDateTo = '';
  }
  showMobileSearch.value = false;
  showTagSuggestions.value = false;
  if (store.selectMode) store.toggleSelectMode();
  // 切到不用筛选的 view (消息通知 / 群组 / AI / 设置 等 hideSearch=true 的) 时彻底清掉 filterCategory + 关筛选面板
  // 之前漏清, 蘑菇报告"进 /notifications /groups 等还能看到旧筛选 chip" — 因为 filterCategory 残留 + showFilters 跟着自动开
  if (route.meta.hideSearch) {
    store.filterCategory = '';
    showFilters.value = false;
  } else {
    // 有分类过滤时保持筛选面板开启
    showFilters.value = !!store.filterCategory;
  }
});

const detailTitle = inject<Ref<string>>('detailTitle', ref(''));
// 资源页面包屑: 因 Resources view 跟 TopBar 是 flex sibling 不是父子链, provide/inject 不通, 用 module-level ref 共享
import { resourceBreadcrumb, resourceBreadcrumbGoTo } from '@/composables/useResourceBreadcrumb';
const title = computed(() => {
  const base = detailTitle.value || (route.meta.title as string) || '';
  if (pageCount.value >= 0) return base;
  if (['inspiration', 'notes', 'todos'].includes(route.name as string) && store.total > 0) return base;
  return base;
});
const notificationsStore = useNotificationsStore();
const titleCount = computed(() => {
  // /notifications: 显示未读总数 (view 内 provide 传不到 TopBar - 兄弟关系, 这里直接接 store)
  if (route.name === 'notifications' && notificationsStore.unread.total > 0) return notificationsStore.unread.total;
  if (pageCount.value >= 0) return pageCount.value;
  if (['inspiration', 'notes', 'todos'].includes(route.name as string) && store.total > 0) return store.total;
  return -1;
});
const hideSearch = computed(() => !!route.meta.hideSearch);
const hideRefresh = computed(() => !!route.meta.hideRefresh);
// 资源/标签/回收站搜索语义不同(搜文件/搜标签/搜回收站内容),不走笔记 fetchNotes,只设 store.searchQuery 让 view 自己 watch
const searchScope = computed(() => {
  if (route.path === '/resources') return 'files';
  if (route.path === '/tags') return 'tags';
  if (route.path === '/trash') return 'trash';
  return 'notes';
});
const searchPlaceholder = computed(() => {
  if (searchScope.value === 'files') return '搜索文件';
  if (searchScope.value === 'tags') return '搜索标签';
  if (searchScope.value === 'trash') return '搜索回收站';
  return '搜索...      Ctrl + F';
});
const hasFilters = computed(() => {
  // 资源页日历按钮高亮态只看日期(类型由页面顶部 chip 控制,日历不管)
  if (searchScope.value === 'files') return !!store.fileDateFrom || !!store.fileDateTo;
  // filterTypes 跟当前 view 默认值不一致 = 用户主动改过类型 (默认就一个,所以不能用 length<3 判断)
  const defaultTypes = getDefaultFilterTypes();
  const typesChanged = filterTypes.value.length !== defaultTypes.length
    || !filterTypes.value.every(t => defaultTypes.includes(t));
  return filterTags.value.length > 0 || !!filterDateFrom.value || !!store.filterCategory || typesChanged;
});

// 把 searchFocused(搜索框焦点) / showMobileSearch(移动端搜索框展开) / hasFilters /
// showFilters(漏斗面板) / searchQuery 合并写回 store.isFiltering,让 Inspiration / Notes /
// Todos 据此隐藏顶部 NoteInput 编辑区.
// 这几个都算"进入筛选模式",哪怕还没具体输入条件(用户意图已经摆出来,让位给搜索体验)
watchEffect(() => {
  // hasFilters 短路返回 string | boolean (filterDateFrom 等是 string),包一层 !! 转成纯 boolean
  store.isFiltering = searchFocused.value || showMobileSearch.value || !!store.searchQuery || !!hasFilters.value || showFilters.value;
});

// PR #8 命名重整: value 跟新字段值一致 (quink=灵感, note=笔记, todo=待办)
const typeOptions = [
  { value: 'quink', label: '灵感', icon: markRaw(PhLightbulb) },
  { value: 'note', label: '笔记', icon: markRaw(PhNotePencil) },
  { value: 'todo', label: '待办', icon: markRaw(PhCheckSquare) },
];

// 资源页日期弹窗(按钮 + 弹窗 + 位置)
const dateFilterOpen = ref(false);
const dateFilterBtn = ref<HTMLElement>();
const dateFilterPos = ref({ top: '0px', right: '0px' });
function openDateFilter() {
  if (dateFilterOpen.value) { dateFilterOpen.value = false; return; }
  if (dateFilterBtn.value) {
    const r = unzoomRect(dateFilterBtn.value);
    const { vw } = unzoomViewport();
    dateFilterPos.value = {
      top: `${r.bottom + 4}px`,
      right: `${vw - r.right}px`,
    };
  }
  dateFilterOpen.value = true;
}
function clearDateFilter() {
  store.fileDateFrom = '';
  store.fileDateTo = '';
  dateFilterOpen.value = false;
}

function toggleType(t: string) {
  const idx = filterTypes.value.indexOf(t);
  if (idx >= 0) {
    if (filterTypes.value.length > 1) filterTypes.value.splice(idx, 1);
  } else {
    filterTypes.value.push(t);
  }
  doSearch(true);
}

const tagSuggestions = computed(() => {
  const q = searchText.value.trim();
  if (!q) return [];
  // pinyinMatch 让"zb"也能匹配"周报"
  return allTags.value.filter(t => pinyinMatch(t, q) && !filterTags.value.includes(t)).slice(0, 6);
});

// 输入框失焦时延迟关闭标签建议下拉（让点击建议项的事件能先触发）
function hideTagSuggestionsDelayed() {
  window.setTimeout(() => { showTagSuggestions.value = false; }, 200);
}

// immediate=true 时跳过 300ms 防抖立即查询，给"清除筛选/选标签/改日期"等明确操作用
function doSearch(immediate = false) {
  clearTimeout(searchTimer);
  const run = () => {
    store.searchQuery = searchText.value;
    // 资源/标签页只设 searchQuery,各 view 自己 watch 过滤,不走笔记 fetchNotes
    if (searchScope.value !== 'notes') return;
    // 用户主动改了 filterTypes (跟当前 view 默认不同) 才走 types 路径覆盖 view 自带的 filterType;
    // 默认状态下保留 view 设的 filterType, 让 fetchNotes 按 store.filterType 单类型过滤.
    // 回到默认时必须显式把 store.filterType 设回 view 默认值: 之前用户加额外 type 时 filterType 已被设为 '',
    // 若不恢复, 用户取消额外 type / 点"清除全部筛选" / ESC 后 fetchNotes 既不带 type 也不带 types, 列表仍混杂.
    const defaultTypes = getDefaultFilterTypes();
    const typesChanged = filterTypes.value.length !== defaultTypes.length
      || !filterTypes.value.every(t => defaultTypes.includes(t));
    if (typesChanged) store.filterType = '';
    else store.filterType = defaultTypes[0] || '';
    store.fetchNotes({
      tags: filterTags.value.length ? filterTags.value.join(',') : undefined,
      types: typesChanged ? filterTypes.value.join(',') : undefined,
      dateFrom: filterDateFrom.value || undefined,
      dateTo: filterDateFrom.value ? (filterDateTo.value || undefined) : undefined,
    });
  };
  if (immediate) run();
  else searchTimer = setTimeout(run, 300);
}

function updateTagSuggestPos() {
  if (!searchBoxEl.value) return;
  const r = unzoomRect(searchBoxEl.value);
  tagSuggestPos.value = {
    top: `${r.bottom + 4}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
  };
}

function onSearch() {
  // 资源/标签页搜索不显示标签建议下拉(语义不对),只走基础 search → store.searchQuery
  if (searchScope.value === 'notes') {
    if (allTags.value.length === 0) {
      api.getTags().then(res => { allTags.value = res.data; }).catch(() => {});
    }
    showTagSuggestions.value = true;
    updateTagSuggestPos();
  }
  doSearch();
}

function addTag(t: string) {
  if (!filterTags.value.includes(t)) filterTags.value.push(t);
  searchText.value = '';
  showTagSuggestions.value = false;
  showFilters.value = true;
  doSearch(true);
}

function removeTag(t: string) {
  filterTags.value = filterTags.value.filter(x => x !== t);
  doSearch(true);
}

// 分类/标签变化时自动展开筛选面板
watch(() => store.filterCategory, (v) => { if (v) showFilters.value = true; });
watch(filterTags, (v) => { if (v.length) showFilters.value = true; }, { deep: true });
function applyFilters() { doSearch(true); }

function clearFilters() {
  if (searchScope.value === 'files') {
    store.fileCategory = 'all';
    store.fileDateFrom = '';
    store.fileDateTo = '';
    return;
  }
  store.filterCategory = '';
  filterTags.value = [];
  filterTypes.value = getDefaultFilterTypes();
  filterDateFrom.value = '';
  filterDateTo.value = new Date().toISOString().slice(0, 10);
  doSearch(true);
}

function clearCategory() {
  store.filterCategory = '';
  doSearch(true);
}

function clearTag() {
  filterTags.value = [];
  doSearch(true);
}

function clearAll() {
  searchText.value = '';
  store.searchQuery = '';
  store.filterCategory = '';
  filterTags.value = [];
  filterDateFrom.value = '';
  filterDateTo.value = new Date().toISOString().slice(0, 10);
  showTagSuggestions.value = false;
  store.fetchNotes();
}

async function toggleFilters() {
  // 收起筛选面板 = 清状态 (跟 ESC 行为一致): 用户点漏斗"关筛选"的语义就是"恢复默认",
  // 不要留 filterTypes / filterTags / filterDateFrom 等残留导致列表仍混杂
  if (showFilters.value) {
    showFilters.value = false;
    searchText.value = '';
    store.searchQuery = '';
    showTagSuggestions.value = false;
    clearFilters();
    return;
  }
  showFilters.value = true;
  if (allTags.value.length === 0) {
    try { const res = await api.getTags(); allTags.value = res.data; } catch {}
  }
}

const isElectron = !!(window as any).quinkDesktop?.isElectron;
const desk = (window as any).quinkDesktop;

async function loadCategories() {
  try { const res = await api.getCategories(); categories.value = res.data; } catch {}
}

watch(() => store.selectMode, (v) => { if (v) loadCategories(); });

const spinning = ref(false);
async function refresh() {
  if (spinning.value) return;
  spinning.value = true;
  // fetchNotes 通常 1-50ms 返回, 太快 spinning 反馈来不及看清; pin 最少 600ms 保证视觉看到完整一圈旋转
  const minDuration = 600;
  const start = Date.now();
  try {
    // 优先调当前 view 注册的 refresh (Inspiration/Notes/Todos 在 onActivated 注册).
    // 没注册时(Trash/Resources/Tags/Stats 等暂未接入, 或 view 刚 deactivated 还没 activate)
    // fallback 到默认: keepCount 保住已 loadMore 出来的条数, 避免 refresh 把 90 条砍回 30 →
    // scrollTop 超过新底部 → 用户必须先往上滚才能继续往下 (浏览器 clamp scrollTop 延迟).
    // fetchNotes 内部保留 lastExtra 让 tag/type/日期 过滤不丢
    if (store.currentRefresh) await store.currentRefresh();
    else await store.fetchNotes(undefined, { keepCount: true });
    window.dispatchEvent(new CustomEvent('quink-refresh'));
  } catch (e) {
    console.error('[refresh] failed:', e);
  } finally {
    const elapsed = Date.now() - start;
    if (elapsed < minDuration) await new Promise(r => setTimeout(r, minDuration - elapsed));
    spinning.value = false;
    toast.show('已刷新');
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    searchInput.value?.focus();
    return;
  }
  // ESC 分级退出: 批量 popover > 筛选菜单 (漏斗下拉 / 资源页日期弹窗) > 多选模式
  if (e.key === 'Escape') {
    if (showBatchType.value || showBatchMove.value || showBatchTags.value || confirmBatchDelete.value) {
      showBatchType.value = false;
      showBatchMove.value = false;
      showBatchTags.value = false;
      confirmBatchDelete.value = false;
      return;
    }
    if (showFilters.value || dateFilterOpen.value) {
      // ESC 退出筛选 = "清除全部筛选"等效: 关下拉 + 清搜索词 + 清所有 filter state, 让编辑区恢复
      // (之前只关下拉不清状态, hasFilters 仍 true 编辑区不出, 跟用户预期不符)
      searchText.value = '';
      store.searchQuery = '';
      showTagSuggestions.value = false;
      showFilters.value = false;
      dateFilterOpen.value = false;
      clearFilters();
      // 主动 blur 搜索框: 用户在搜索框按 ESC 时焦点仍在 input → searchFocused=true →
      // isFiltering watchEffect 仍返回 true → 编辑区不显示. blur 后 searchFocused=false 才能恢复
      searchInput.value?.blur();
      return;
    }
    if (store.selectMode) {
      store.toggleSelectMode();
    }
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('quink-filter-tag', ((e: CustomEvent) => {
    const tag = e.detail;
    if (tag && !filterTags.value.includes(tag)) {
      filterTags.value = [tag];
      filterTypes.value = getDefaultFilterTypes();
      showFilters.value = true;
      doSearch(true);
    }
  }) as EventListener);
  // 统计页热力图 → 灵感页跨视图跳转: 单日筛选(dateFrom=dateTo=date),types 全选不限类型
  // 注意 watch(route.path) 会先清空 filterDateFrom/filterDateTo,所以本事件必须在路由切完后(onActivated)派出来才能盖回去
  window.addEventListener('quink-filter-date', ((e: CustomEvent) => {
    const date = e.detail;
    if (!date) return;
    filterDateFrom.value = date;
    filterDateTo.value = date;
    filterTypes.value = getDefaultFilterTypes();
    showFilters.value = true;
    doSearch(true);
  }) as EventListener);
});
onUnmounted(() => { document.removeEventListener('keydown', handleKeydown); });
</script>

<template>
  <!-- header 本身透明: 把背景搬到 main bar / mobile search / filter bar 各自子元素上,
       这样多选 batch bar 没 background 时, 透过 batch bar 看到的是 main 区里的卡片(不是 header bg),
       视觉上跟回收站 sticky toolbar 一致(都是 bg-gray-50/80 半透明真正透出 main 卡片). -->
  <header class="shrink-0"
    style="box-shadow: 0 1px 3px var(--c-topbar-shadow), 0 1px 0 var(--sb-border)">
    <!-- Main bar -->
    <div class="h-12 md:h-14 flex items-center justify-between px-3 md:px-6 gap-2" style="background: var(--c-topbar)">
      <!-- Left: menu + title -->
      <div class="flex items-center gap-2 shrink-0">
        <button @click="toggleMobileSidebar?.()" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 md:hidden" title="菜单">
          <PhList size="1.25rem" weight="fill" />
        </button>
        <button v-if="!hideRefresh" @click="refresh" class="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors hidden md:block" title="刷新">
          <!-- 用 CSS animation 一次完整 360° 旋转 (跟 spinning state 同步 600ms); 之前用 transition transform 在 fetchNotes 极快返回时只看到一瞬抖动 -->
          <PhArrowsClockwise size="0.875rem" weight="fill" :class="{ 'refresh-spin': spinning }" />
        </button>
        <h1 class="text-sm md:text-base font-semibold text-gray-800 whitespace-nowrap">{{ title }}<span v-if="titleCount >= 0" class="text-xs text-gray-400 font-normal tabular-nums">（{{ titleCount }}）</span></h1>
        <!-- 资源页面包屑: 在"资源"标题后渲染. 进入子目录时 "资源 > 根目录 > 文件夹A > 子B" 含可点的"根目录" 起点 -->
        <template v-if="resourceBreadcrumb.length > 0">
          <PhCaretRight size="0.75rem" weight="bold" class="text-gray-300 shrink-0" />
          <button @click="resourceBreadcrumbGoTo && resourceBreadcrumbGoTo(null)"
            class="text-sm md:text-base font-medium whitespace-nowrap px-1.5 py-0.5 rounded text-gray-500 hover:bg-gray-100 transition-colors">
            根目录
          </button>
          <template v-for="(b, i) in resourceBreadcrumb" :key="b.id">
            <PhCaretRight size="0.75rem" weight="bold" class="text-gray-300 shrink-0" />
            <button @click="resourceBreadcrumbGoTo && resourceBreadcrumbGoTo(b.id)"
              class="text-sm md:text-base font-medium whitespace-nowrap px-1.5 py-0.5 rounded hover:bg-gray-100 transition-colors"
              :class="i === resourceBreadcrumb.length - 1 ? 'text-gray-800' : 'text-gray-500'">
              {{ b.name }}
            </button>
          </template>
        </template>
      </div>

      <!-- Right: search -->
      <div v-if="!hideSearch" class="flex items-center gap-1.5">
        <!-- Desktop search -->
        <div ref="searchBoxEl" data-search-box class="hidden md:block w-56">
          <div class="flex items-center bg-gray-100/80 rounded-full border border-gray-200 focus-within:bg-white focus-within:ring-2 focus-within:ring-primary/30 focus-within:border-primary/40 transition overflow-hidden">
            <PhMagnifyingGlass size="1rem" weight="fill" class="ml-3 text-gray-400 shrink-0" />
            <input ref="searchInput" v-model="searchText" @input="onSearch"
              @focus="searchFocused = true; onSearch()"
              @blur="searchFocused = false; hideTagSuggestionsDelayed()" type="text"
              :placeholder="searchPlaceholder"
              class="flex-1 min-w-0 px-2 py-1.5 border-0 text-sm outline-none placeholder-gray-400"
              style="background: transparent !important" />
            <!-- 清空搜索 -->
            <button v-if="searchText" @click="searchText = ''; store.searchQuery = ''; doSearch(true)"
              class="mr-2 p-0 text-gray-400 hover:text-gray-600 shrink-0 transition-colors flex items-center" title="清空">
              <PhXCircle size="1rem" weight="fill" />
            </button>
          </div>
        </div>

        <!-- Mobile search toggle -->
        <button @click="showMobileSearch = !showMobileSearch" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 md:hidden">
          <PhMagnifyingGlass size="1.25rem" weight="fill" />
        </button>

        <!-- 笔记页: PhFunnel + 横向 filter bar;资源页: PhCalendarBlank + 下方日期弹窗;标签页: invisible 占位保持搜索框对齐 -->
        <button v-if="searchScope === 'files'" ref="dateFilterBtn" @click="openDateFilter"
          class="p-1.5 rounded-lg transition-colors hidden md:block"
          :class="dateFilterOpen || hasFilters ? 'bg-primary-light text-primary-dark' : 'hover:bg-gray-100 text-gray-400 hover:text-gray-600'"
          title="按时间筛选">
          <PhCalendarBlank size="1rem" weight="fill" />
        </button>
        <button v-else @click="toggleFilters" class="p-1.5 rounded-lg transition-colors hidden md:block"
          :class="[
            showFilters || hasFilters ? 'bg-primary-light text-primary-dark' : 'hover:bg-gray-100 text-gray-400 hover:text-gray-600',
            searchScope === 'tags' || searchScope === 'trash' ? 'invisible pointer-events-none' : '',
          ]">
          <PhFunnel size="1rem" weight="fill" />
        </button>
      </div>
    </div>

    <!-- Mobile search bar (expanded) -->
    <div v-if="showMobileSearch" class="px-3 pb-2 md:hidden" style="background: var(--c-topbar)">
      <div class="relative">
        <input v-model="searchText" @input="onSearch" type="text" :placeholder="searchPlaceholder"
          class="w-full pl-9 pr-3 py-2 bg-gray-100/80 border-0 rounded-full text-sm outline-none focus:bg-white focus:ring-2 focus:ring-primary/30 placeholder-gray-400" autofocus />
        <PhMagnifyingGlass size="1rem" weight="fill" class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      </div>
    </div>

    <!-- 笔记页横向 filter bar(标签/资源页都不显示横向 bar,它们各自有专属交互) -->
    <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0 -translate-y-1"
      leave-active-class="transition duration-100 ease-in" leave-to-class="opacity-0 -translate-y-1">
      <div v-if="showFilters && searchScope === 'notes'" class="px-6 pb-3 space-y-2 hidden md:block" style="background: var(--c-topbar)">
        <!-- 类型 + 时间 + 清除 -->
        <div class="flex items-center gap-3 h-7">
          <span class="text-xs text-gray-400 w-8 shrink-0">类型</span>
          <div class="flex items-center gap-1">
            <button v-for="t in typeOptions" :key="t.value" @click="toggleType(t.value)"
              class="px-2.5 py-0.5 rounded-full text-xs font-medium transition-all inline-flex items-center gap-1"
              :class="filterTypes.includes(t.value) ? 'bg-primary text-white shadow-sm' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'">
              <component :is="t.icon" size="0.75rem" weight="fill" />
              {{ t.label }}
            </button>
          </div>
          <span class="text-gray-200">|</span>
          <span class="text-xs text-gray-400 shrink-0">时间</span>
          <div class="w-36">
            <DatePicker
              :model-value="filterDateFrom"
              placeholder="开始"
              @update:model-value="v => { filterDateFrom = v; applyFilters() }"
            />
          </div>
          <span class="text-xs text-gray-400">-</span>
          <div class="w-36">
            <DatePicker
              :model-value="filterDateTo"
              placeholder="结束"
              @update:model-value="v => { filterDateTo = v; applyFilters() }"
            />
          </div>
          <button @click="clearFilters"
            class="text-xs font-medium px-3 py-1 rounded-lg transition-colors ml-auto shrink-0"
            :class="hasFilters ? 'text-white bg-red-400 hover:bg-red-500' : 'text-gray-400 bg-gray-100 hover:bg-gray-200'">
            清除全部筛选
          </button>
        </div>
        <!-- 分类 + 标签 -->
        <div class="flex items-center gap-3 h-7">
          <span class="text-xs text-gray-400 w-8 shrink-0">筛选</span>
          <div class="flex items-center gap-1.5 flex-wrap">
            <span v-if="store.filterCategory" class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium"
              style="background: #FFE0CC; color: #D46B27">
              <span class="truncate max-w-[120px] inline-flex items-center gap-1"><PhFolderOpen size="0.75rem" weight="fill" />{{ store.filterCategory }}</span>
              <button @click="clearCategory()" class="hover:opacity-60 shrink-0">×</button>
            </span>
            <span v-for="t in filterTags" :key="t" class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-primary-light text-primary-dark">
              <PhTag size="0.75rem" weight="fill" />
              <span>{{ t }}</span>
              <button @click="removeTag(t)" class="hover:opacity-60">×</button>
            </span>
            <span v-if="!store.filterCategory && !filterTags.length" class="text-xs text-gray-300">无（侧边栏选分类，搜索栏输入匹配标签）</span>
          </div>
        </div>
      </div>
    </Transition>

  </header>

  <!-- Batch action bar 用 Teleport 渲染到 main 内 portal (App.vue 内 #batch-bar-portal),
       让 batch bar 物理位置在 main 内 sticky top-0, 跟卡片在同一 overflow 容器,
       半透明 bg-gray-50/80 透过去能看到下方卡片轮廓 (跟回收站 sticky toolbar 同款视觉).
       Vue context 仍在 TopBar 不变, 所有按钮回调 (toggleBatchType / batchDelete 等) 照常工作.
       pt-[8px] pb-[10px] 抵消中文字符 baseline 在 line-box 内自然偏下的视觉偏差. -->
  <Teleport to="#batch-bar-portal" defer>
    <div v-if="store.selectMode"
      class="sticky top-0 z-[var(--z-sticky)] px-4 md:px-6 pt-[8px] pb-[10px] flex items-center gap-3 border-t border-gray-100 bg-gray-50/80"
      style="box-shadow: 0 1px 3px var(--c-topbar-shadow), 0 1px 0 var(--sb-border)">
      <span class="text-xs text-gray-500">已选 {{ store.selectedIds.size }} 项</span>
      <button @click="store.selectAll()" class="text-xs text-primary hover:underline">全选</button>
      <button @click="store.toggleSelectMode()" class="text-xs text-gray-400 hover:underline">退出选择</button>
      <div class="ml-auto flex items-center gap-2">
        <!-- 顺序: (待办页) 标记已完成 / 标记未完成 → 移至类型 → 移动分类 → 加标签 → 删除 (跨类型操作前置, 跟分类语义优先级一致) -->
        <!-- 待办页专属: 批量改 todoStatus, 已是目标状态 / 非 todo 项静默跳过 -->
        <button v-if="store.filterType === 'todo'" @click="doBatchSetTodoStatus('done')"
          class="px-3 py-1 text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:bg-primary/15 transition-colors">
          标记已完成
        </button>
        <button v-if="store.filterType === 'todo'" @click="doBatchSetTodoStatus('pending')"
          class="px-3 py-1 text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:bg-primary/15 transition-colors">
          标记未完成
        </button>
        <button ref="batchTypeBtn" @click="toggleBatchType"
          class="px-3 py-1 text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:bg-primary/15 transition-colors">
          移至类型
        </button>
        <button ref="batchMoveBtn" @click="toggleBatchMove"
          class="px-3 py-1 text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:bg-primary/15 transition-colors">
          移动分类
        </button>
        <button ref="batchTagsBtn" @click="toggleBatchTags"
          class="px-3 py-1 text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:bg-primary/15 transition-colors">
          加标签
        </button>
        <button @click="confirmBatchDelete = true"
          class="px-3 py-1 text-xs rounded-lg font-medium bg-red-50 text-red-500 hover:bg-red-100 transition-colors">
          删除
        </button>
      </div>
    </div>
  </Teleport>

  <!-- 资源页日期筛选弹窗(Teleport + fixed,按钮下方向左展开 = 弹窗右上对齐按钮右下) -->
  <Teleport to="body">
    <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 -translate-y-1"
      leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0">
      <div v-if="dateFilterOpen"
        class="fixed z-[var(--z-overlay)] bg-white border border-gray-200 rounded-xl shadow-lg p-3 w-56"
        :style="dateFilterPos">
        <div class="text-[11px] text-gray-400 mb-2">按时间筛选</div>
        <div class="space-y-2">
          <div>
            <label class="block text-[11px] text-gray-500 mb-0.5">开始日期</label>
            <DatePicker v-model="store.fileDateFrom" placeholder="开始日期" />
          </div>
          <div>
            <label class="block text-[11px] text-gray-500 mb-0.5">结束日期</label>
            <DatePicker v-model="store.fileDateTo" placeholder="结束日期" />
          </div>
        </div>
        <!-- 即时搜索已生效,"确定"语义就是关弹窗(用户心理舒服);清除按钮挪到资源页 chip 行 -->
        <button @click="dateFilterOpen = false"
          class="mt-3 w-full inline-flex items-center justify-center gap-1 text-xs py-1.5 rounded-lg bg-primary-light text-primary-dark hover:bg-primary/15 transition-colors">
          <PhCheck size="0.875rem" weight="fill" />
          <span>确定</span>
        </button>
      </div>
    </Transition>
    <div v-if="dateFilterOpen" class="fixed inset-0 z-[var(--z-overlay-backdrop)]" @click="dateFilterOpen = false" />
  </Teleport>

  <!-- 标签建议下拉（Teleport 到 body，避开主区编辑器层级） -->
  <Teleport to="body">
    <div v-if="showTagSuggestions && tagSuggestions.length"
      class="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-[var(--z-overlay)]"
      :style="tagSuggestPos">
      <button v-for="t in tagSuggestions" :key="t" @mousedown.prevent="addTag(t)"
        class="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 flex items-center gap-1.5">
        <span class="px-1.5 py-0.5 rounded-full bg-primary-light text-primary-dark inline-flex items-center"><PhTag size="0.625rem" weight="fill" /></span>
        {{ t }}
      </button>
    </div>
  </Teleport>

  <!-- 移动分类下拉 -->
  <Teleport to="body">
    <div v-if="showBatchMove" class="fixed z-[var(--z-overlay)]" :style="batchMovePos">
      <div class="bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-40 max-h-48 overflow-y-auto">
        <button v-for="cat in categories" :key="cat.id"
          @click="(async () => { showBatchMove = false; const r = await store.batchMove(cat.name); reportBatch(r, '移到分类'); })()"
          class="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 truncate inline-flex items-center gap-1.5 w-full" :title="cat.name">
          <PhFolderOpen size="0.75rem" weight="fill" />
          <span class="truncate">{{ cat.name }}</span>
        </button>
        <div v-if="categories.length === 0" class="px-3 py-2 text-xs text-gray-400">无分类</div>
      </div>
    </div>
    <div v-if="showBatchMove" class="fixed inset-0 z-[var(--z-overlay-backdrop)]" @click="showBatchMove = false" />
  </Teleport>

  <!-- 批量"移至类型"下拉 (灵感/笔记/待办 三选) -->
  <Teleport to="body">
    <div v-if="showBatchType" class="fixed z-[var(--z-overlay)]" :style="batchTypePos">
      <div class="bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-32">
        <button @click="pickBatchType('quink')"
          class="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1.5">
          <PhLightbulb size="0.75rem" weight="fill" />
          <span>灵感</span>
        </button>
        <button @click="pickBatchType('note')"
          class="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1.5">
          <PhNotePencil size="0.75rem" weight="fill" />
          <span>笔记</span>
        </button>
        <button @click="pickBatchType('todo')"
          class="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1.5">
          <PhCheckSquare size="0.75rem" weight="fill" />
          <span>待办</span>
        </button>
      </div>
    </div>
    <div v-if="showBatchType" class="fixed inset-0 z-[var(--z-overlay-backdrop)]" @click="showBatchType = false" />
  </Teleport>

  <!-- 批量"加标签"弹窗 (输入框 + 建议 + 已选 chip + 确认) -->
  <Teleport to="body">
    <div v-if="showBatchTags" class="fixed z-[var(--z-overlay)] bg-white border border-gray-200 rounded-xl shadow-lg p-3 w-60" :style="batchTagsPos">
      <div class="text-[11px] text-gray-400 mb-2">为选中笔记加标签</div>
      <!-- 已选 chip 列表 -->
      <div v-if="batchTagsSelected.length" class="flex flex-wrap gap-1 mb-2">
        <span v-for="t in batchTagsSelected" :key="t" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-primary-light text-primary-dark">
          <PhTag size="0.625rem" weight="fill" />
          <span>{{ t }}</span>
          <button @click="removeBatchTag(t)" class="hover:opacity-60">×</button>
        </span>
      </div>
      <input v-model="batchTagInput" @keydown.enter.prevent="onBatchTagInputEnter" type="text"
        placeholder="输入标签名,回车添加"
        class="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:border-primary bg-white" />
      <!-- 建议: 输入时 fuzzy 过滤, 无输入时显示前 6 个未选 (跟 sidebar 搜索建议同模式) -->
      <div v-if="batchTagSuggestions.length" class="mt-2 max-h-32 overflow-y-auto">
        <button v-for="t in batchTagSuggestions" :key="t" @click="addBatchTag(t)"
          class="w-full text-left px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 rounded inline-flex items-center gap-1.5">
          <PhTag size="0.625rem" weight="fill" class="text-primary-dark" />
          <span>{{ t }}</span>
        </button>
      </div>
      <button @click="confirmBatchTags" :disabled="!batchTagsSelected.length"
        class="mt-3 w-full inline-flex items-center justify-center gap-1 text-xs py-1.5 rounded-lg bg-primary-light text-primary-dark hover:bg-primary/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
        <PhCheck size="0.875rem" weight="fill" />
        <span>添加 {{ batchTagsSelected.length || '' }} 个标签到 {{ store.selectedIds.size }} 项</span>
      </button>
    </div>
    <div v-if="showBatchTags" class="fixed inset-0 z-[var(--z-overlay-backdrop)]" @click="showBatchTags = false" />
  </Teleport>

  <!-- 批量删除确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmBatchDelete" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmBatchDelete = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">删除内容</p>
          <p class="text-xs text-gray-400 mb-4">将 {{ store.selectedIds.size }} 条内容移至回收站</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmBatchDelete = false" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doBatchDelete" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 刷新按钮: 点击触发一次完整 360° 旋转 (跟 refresh() 内 minDuration=600 同步).
   CSS animation 比 transition 稳: animation 是从 0→360 一次性, 即使 spinning state 提前 false 也不打断当前动画 */
@keyframes refresh-spin {
  from { transform: rotate(0); }
  to { transform: rotate(360deg); }
}
.refresh-spin {
  animation: refresh-spin 0.6s ease-out;
}
</style>
