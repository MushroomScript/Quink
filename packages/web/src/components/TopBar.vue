<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, watchEffect, inject, type Ref } from 'vue';
import { useRoute } from 'vue-router';
import { useNotesStore } from '@/stores/notes';
import { api, type Category } from '@/api';
import { markRaw } from 'vue';
import { PhList, PhArrowsClockwise, PhMagnifyingGlass, PhXCircle, PhFunnel, PhLightbulb, PhNotePencil, PhCheckSquare, PhTag, PhFolderOpen, PhCalendarBlank, PhCheck } from '@phosphor-icons/vue';
import { pinyinMatch } from '@/utils/pinyin';

const toggleMobileSidebar = inject<() => void>('toggleMobileSidebar');

const route = useRoute();
const store = useNotesStore();
const categories = ref<Category[]>([]);
const showBatchMove = ref(false);
const batchMoveBtn = ref<HTMLElement>();
const batchMovePos = ref({ top: '0px', left: '0px' });

function toggleBatchMove() {
  showBatchMove.value = !showBatchMove.value;
  if (showBatchMove.value) {
    if (categories.value.length === 0) loadCategories();
    if (batchMoveBtn.value) {
      const r = batchMoveBtn.value.getBoundingClientRect();
      const top = r.bottom + 4;
      const left = r.right - 160;
      batchMovePos.value = { top: top + 'px', left: left + 'px' };
    }
  }
}
const confirmBatchDelete = ref(false);
const searchInput = ref<HTMLInputElement>();
const searchBoxEl = ref<HTMLElement>();
const tagSuggestPos = ref({ top: '0px', left: '0px', width: '0px' });
const searchText = ref('');
const searchFocused = ref(false);
const showFilters = ref(false);
const showMobileSearch = ref(false);
const filterTags = ref<string[]>([]);
const filterTypes = ref<string[]>(['note', 'snippet', 'todo']);
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
  filterTypes.value = ['note', 'snippet', 'todo'];
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
  // 有分类过滤时保持筛选面板开启
  showFilters.value = !!store.filterCategory;
});

const detailTitle = inject<Ref<string>>('detailTitle', ref(''));
const pageCount = inject<Ref<number>>('pageCount', ref(-1));
const title = computed(() => {
  const base = detailTitle.value || (route.meta.title as string) || '';
  if (pageCount.value >= 0) return base;
  if (['inspiration', 'notes', 'todos'].includes(route.name as string) && store.total > 0) return base;
  return base;
});
const titleCount = computed(() => {
  if (pageCount.value >= 0) return pageCount.value;
  if (['inspiration', 'notes', 'todos'].includes(route.name as string) && store.total > 0) return store.total;
  return -1;
});
const hideSearch = computed(() => !!route.meta.hideSearch);
const hideRefresh = computed(() => !!route.meta.hideRefresh);
// 资源/标签页搜索语义不同(搜文件 / 搜标签),不走笔记 fetchNotes,只设 store.searchQuery 让 view 自己 watch
const searchScope = computed(() => {
  if (route.path === '/resources') return 'files';
  if (route.path === '/tags') return 'tags';
  return 'notes';
});
const searchPlaceholder = computed(() => {
  if (searchScope.value === 'files') return '搜索文件';
  if (searchScope.value === 'tags') return '搜索标签';
  return '搜索...      Ctrl + F';
});
const hasFilters = computed(() => {
  // 资源页日历按钮高亮态只看日期(类型由页面顶部 chip 控制,日历不管)
  if (searchScope.value === 'files') return !!store.fileDateFrom || !!store.fileDateTo;
  return filterTags.value.length > 0 || filterDateFrom.value || store.filterCategory || filterTypes.value.length < 3;
});

// 把 searchFocused(搜索框焦点) / showMobileSearch(移动端搜索框展开) / hasFilters /
// showFilters(漏斗面板) / searchQuery 合并写回 store.isFiltering,让 Inspiration / Notes /
// Todos 据此隐藏顶部 NoteInput 编辑区.
// 这几个都算"进入筛选模式",哪怕还没具体输入条件(用户意图已经摆出来,让位给搜索体验)
watchEffect(() => {
  // hasFilters 短路返回 string | boolean (filterDateFrom 等是 string),包一层 !! 转成纯 boolean
  store.isFiltering = searchFocused.value || showMobileSearch.value || !!store.searchQuery || !!hasFilters.value || showFilters.value;
});

const typeOptions = [
  { value: 'note', label: '灵感', icon: markRaw(PhLightbulb) },
  { value: 'snippet', label: '笔记', icon: markRaw(PhNotePencil) },
  { value: 'todo', label: '待办', icon: markRaw(PhCheckSquare) },
];

// 资源页日期弹窗(按钮 + 弹窗 + 位置)
const dateFilterOpen = ref(false);
const dateFilterBtn = ref<HTMLElement>();
const dateFilterPos = ref({ top: '0px', right: '0px' });
function openDateFilter() {
  if (dateFilterOpen.value) { dateFilterOpen.value = false; return; }
  if (dateFilterBtn.value) {
    const r = dateFilterBtn.value.getBoundingClientRect();
    dateFilterPos.value = {
      top: `${r.bottom + 4}px`,
      right: `${window.innerWidth - r.right}px`,
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
    // types 筛选激活时覆盖页面级 filterType
    const useTypes = filterTypes.value.length < 3;
    if (useTypes) store.filterType = '';
    store.fetchNotes({
      tags: filterTags.value.length ? filterTags.value.join(',') : undefined,
      types: useTypes ? filterTypes.value.join(',') : undefined,
      dateFrom: filterDateFrom.value || undefined,
      dateTo: filterDateFrom.value ? (filterDateTo.value || undefined) : undefined,
    });
  };
  if (immediate) run();
  else searchTimer = setTimeout(run, 300);
}

function updateTagSuggestPos() {
  if (!searchBoxEl.value) return;
  const r = searchBoxEl.value.getBoundingClientRect();
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
  filterTypes.value = ['note', 'snippet', 'todo'];
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
  showFilters.value = !showFilters.value;
  if (showFilters.value && allTags.value.length === 0) {
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
  try { await store.fetchNotes(); window.dispatchEvent(new CustomEvent('quink-refresh')); } catch {}
  spinning.value = false;
}

function handleKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    searchInput.value?.focus();
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('quink-filter-tag', ((e: CustomEvent) => {
    const tag = e.detail;
    if (tag && !filterTags.value.includes(tag)) {
      filterTags.value = [tag];
      filterTypes.value = ['note', 'snippet', 'todo'];
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
    filterTypes.value = ['note', 'snippet', 'todo'];
    showFilters.value = true;
    doSearch(true);
  }) as EventListener);
});
onUnmounted(() => { document.removeEventListener('keydown', handleKeydown); });
</script>

<template>
  <header class="shrink-0 backdrop-blur-md"
    style="background: var(--c-topbar); box-shadow: 0 1px 3px var(--c-topbar-shadow), 0 1px 0 var(--sb-border)">
    <!-- Main bar -->
    <div class="h-12 md:h-14 flex items-center justify-between px-3 md:px-6 gap-2">
      <!-- Left: menu + title -->
      <div class="flex items-center gap-2 shrink-0">
        <button @click="toggleMobileSidebar?.()" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 md:hidden" title="菜单">
          <PhList size="1.25rem" weight="fill" />
        </button>
        <button v-if="!hideRefresh" @click="refresh" class="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors hidden md:block" title="刷新">
          <PhArrowsClockwise size="0.875rem" weight="fill" class="transition-transform duration-500" :style="spinning ? 'transform: rotate(360deg)' : ''" />
        </button>
        <h1 class="text-sm md:text-base font-semibold text-gray-800 whitespace-nowrap">{{ title }}<span v-if="titleCount >= 0" class="text-xs text-gray-400 font-normal tabular-nums">（{{ titleCount }}）</span></h1>
      </div>

      <!-- Right: search -->
      <div v-if="!hideSearch" class="flex items-center gap-1.5">
        <!-- Desktop search -->
        <div ref="searchBoxEl" class="hidden md:block w-56">
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
            searchScope === 'tags' ? 'invisible pointer-events-none' : '',
          ]">
          <PhFunnel size="1rem" weight="fill" />
        </button>
      </div>
    </div>

    <!-- Mobile search bar (expanded) -->
    <div v-if="showMobileSearch" class="px-3 pb-2 md:hidden">
      <div class="relative">
        <input v-model="searchText" @input="onSearch" type="text" :placeholder="searchPlaceholder"
          class="w-full pl-9 pr-3 py-2 bg-gray-100/80 border-0 rounded-full text-sm outline-none focus:bg-white focus:ring-2 focus:ring-primary/30 placeholder-gray-400" autofocus />
        <PhMagnifyingGlass size="1rem" weight="fill" class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      </div>
    </div>

    <!-- 笔记页横向 filter bar(标签/资源页都不显示横向 bar,它们各自有专属交互) -->
    <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0 -translate-y-1"
      leave-active-class="transition duration-100 ease-in" leave-to-class="opacity-0 -translate-y-1">
      <div v-if="showFilters && searchScope === 'notes'" class="px-6 pb-3 space-y-2 hidden md:block">
        <!-- 类型 + 时间 + 清除 -->
        <div class="flex items-center gap-3 h-7">
          <span class="text-xs text-gray-400 w-8 shrink-0">类型</span>
          <div class="flex items-center gap-1">
            <button v-for="t in typeOptions" :key="t.value" @click="toggleType(t.value)"
              class="px-2 py-0.5 rounded-full text-xs font-medium transition-colors inline-flex items-center gap-1"
              :class="filterTypes.includes(t.value) ? 'bg-primary-light text-primary-dark' : 'bg-gray-100 text-gray-400'">
              <component :is="t.icon" size="0.75rem" weight="fill" />
              {{ t.label }}
            </button>
          </div>
          <span class="text-gray-200">|</span>
          <span class="text-xs text-gray-400 shrink-0">时间</span>
          <input v-model="filterDateFrom" @change="applyFilters" type="date" class="px-2 py-1 border border-gray-200 rounded-lg text-xs outline-none bg-white" />
          <span class="text-xs text-gray-400">-</span>
          <input v-model="filterDateTo" @change="applyFilters" type="date" class="px-2 py-1 border border-gray-200 rounded-lg text-xs outline-none bg-white" />
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

    <!-- Batch action bar -->
    <div v-if="store.selectMode"
      class="px-4 md:px-6 py-2 flex items-center gap-3 border-t border-gray-100 bg-gray-50/80">
      <span class="text-xs text-gray-500">已选 {{ store.selectedIds.size }} 项</span>
      <button @click="store.selectAll()" class="text-xs text-primary hover:underline">全选</button>
      <button @click="store.toggleSelectMode()" class="text-xs text-gray-400 hover:underline">退出选择</button>
      <div class="ml-auto flex items-center gap-2">
        <div class="relative">
          <button ref="batchMoveBtn" @click="toggleBatchMove" class="px-3 py-1 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100">
            移动分类
          </button>
        </div>
        <button @click="confirmBatchDelete = true"
          class="px-3 py-1 text-xs rounded-lg border border-gray-200 text-red-500 hover:bg-red-50 transition-colors">
          删除
        </button>
      </div>
    </div>
  </header>

  <!-- 资源页日期筛选弹窗(Teleport + fixed,按钮下方向左展开 = 弹窗右上对齐按钮右下) -->
  <Teleport to="body">
    <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 -translate-y-1"
      leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0">
      <div v-if="dateFilterOpen"
        class="fixed z-[9999] bg-white border border-gray-200 rounded-xl shadow-lg p-3 w-56"
        :style="dateFilterPos">
        <div class="text-[11px] text-gray-400 mb-2">按时间筛选</div>
        <div class="space-y-2">
          <div>
            <label class="block text-[11px] text-gray-500 mb-0.5">开始日期</label>
            <input v-model="store.fileDateFrom" type="date" class="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:border-primary bg-white" />
          </div>
          <div>
            <label class="block text-[11px] text-gray-500 mb-0.5">结束日期</label>
            <input v-model="store.fileDateTo" type="date" class="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:border-primary bg-white" />
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
    <div v-if="dateFilterOpen" class="fixed inset-0 z-[9998]" @click="dateFilterOpen = false" />
  </Teleport>

  <!-- 标签建议下拉（Teleport 到 body，避开主区编辑器层级） -->
  <Teleport to="body">
    <div v-if="showTagSuggestions && tagSuggestions.length"
      class="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-[9999]"
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
    <div v-if="showBatchMove" class="fixed z-[9999]" :style="batchMovePos">
      <div class="bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-40 max-h-48 overflow-y-auto">
        <button v-for="cat in categories" :key="cat.id"
          @click="store.batchMove(cat.name); showBatchMove = false"
          class="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 truncate inline-flex items-center gap-1.5 w-full" :title="cat.name">
          <PhFolderOpen size="0.75rem" weight="fill" />
          <span class="truncate">{{ cat.name }}</span>
        </button>
        <div v-if="categories.length === 0" class="px-3 py-2 text-xs text-gray-400">无分类</div>
      </div>
    </div>
    <div v-if="showBatchMove" class="fixed inset-0 z-[9998]" @click="showBatchMove = false" />
  </Teleport>

  <!-- 批量删除确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmBatchDelete" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmBatchDelete = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">删除笔记</p>
          <p class="text-xs text-gray-400 mb-4">确认删除选中的 {{ store.selectedIds.size }} 条笔记？</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmBatchDelete = false" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="store.batchDelete(); confirmBatchDelete = false" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
