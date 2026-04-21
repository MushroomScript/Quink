<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, inject, type Ref } from 'vue';
import { useRoute } from 'vue-router';
import { useNotesStore } from '@/stores/notes';
import { api, type Category } from '@/api';

const toggleMobileSidebar = inject<() => void>('toggleMobileSidebar');

const route = useRoute();
const store = useNotesStore();
const categories = ref<Category[]>([]);
const showBatchMove = ref(false);
const confirmBatchDelete = ref(false);
const searchInput = ref<HTMLInputElement>();
const searchText = ref('');
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
  filterTags.value = [];
  filterTypes.value = ['note', 'snippet', 'todo'];
  filterDateFrom.value = '';
  filterDateTo.value = new Date().toISOString().slice(0, 10);
  showMobileSearch.value = false;
  showTagSuggestions.value = false;
  if (store.selectMode) store.toggleSelectMode();
  // 有分类过滤时保持筛选面板开启
  showFilters.value = !!store.filterCategory;
});

const detailTitle = inject<Ref<string>>('detailTitle', ref(''));
const title = computed(() => detailTitle.value || (route.meta.title as string) || '');
const hideSearch = computed(() => !!route.meta.hideSearch);
const hasFilters = computed(() => filterTags.value.length > 0 || filterDateFrom.value || store.filterCategory || filterTypes.value.length < 3);

const typeOptions = [
  { value: 'note', label: '灵感', icon: '💡' },
  { value: 'snippet', label: '笔记', icon: '📝' },
  { value: 'todo', label: '待办', icon: '✅' },
];

function toggleType(t: string) {
  const idx = filterTypes.value.indexOf(t);
  if (idx >= 0) {
    if (filterTypes.value.length > 1) filterTypes.value.splice(idx, 1);
  } else {
    filterTypes.value.push(t);
  }
  doSearch();
}

const tagSuggestions = computed(() => {
  const q = searchText.value.trim();
  if (!q) return [];
  return allTags.value.filter(t => t.includes(q) && !filterTags.value.includes(t)).slice(0, 6);
});

function doSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    store.searchQuery = searchText.value;
    // types 筛选激活时覆盖页面级 filterType
    const useTypes = filterTypes.value.length < 3;
    if (useTypes) store.filterType = '';
    store.fetchNotes({
      tags: filterTags.value.length ? filterTags.value.join(',') : undefined,
      types: useTypes ? filterTypes.value.join(',') : undefined,
      dateFrom: filterDateFrom.value || undefined,
      dateTo: filterDateFrom.value ? (filterDateTo.value || undefined) : undefined,
    });
  }, 300);
}

function onSearch() {
  // 加载标签列表(首次)
  if (allTags.value.length === 0) {
    api.getTags().then(res => { allTags.value = res.data; }).catch(() => {});
  }
  showTagSuggestions.value = true;
  doSearch();
}

function addTag(t: string) {
  if (!filterTags.value.includes(t)) filterTags.value.push(t);
  searchText.value = '';
  showTagSuggestions.value = false;
  showFilters.value = true;
  doSearch();
}

function removeTag(t: string) {
  filterTags.value = filterTags.value.filter(x => x !== t);
  doSearch();
}

// 分类/标签变化时自动展开筛选面板
watch(() => store.filterCategory, (v) => { if (v) showFilters.value = true; });
watch(filterTags, (v) => { if (v.length) showFilters.value = true; }, { deep: true });
function applyFilters() { doSearch(); }

function clearFilters() {
  store.filterCategory = '';
  filterTags.value = [];
  filterTypes.value = ['note', 'snippet', 'todo'];
  filterDateFrom.value = '';
  filterDateTo.value = new Date().toISOString().slice(0, 10);
  doSearch();
}

function clearCategory() {
  store.filterCategory = '';
  doSearch();
}

function clearTag() {
  filterTags.value = [];
  doSearch();
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

onMounted(() => { document.addEventListener('keydown', handleKeydown); });
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
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <h1 class="text-sm md:text-base font-semibold text-gray-800 whitespace-nowrap">{{ title }}</h1>
        <button @click="refresh" class="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors hidden md:block" title="刷新">
          <svg class="w-3.5 h-3.5 transition-transform duration-500" :style="spinning ? 'transform: rotate(360deg)' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      <!-- Right: search -->
      <div v-if="!hideSearch" class="flex items-center gap-1.5">
        <!-- Desktop search -->
        <div class="relative hidden md:flex items-center w-56 bg-gray-100/80 rounded-full border border-gray-200 focus-within:bg-white focus-within:ring-2 focus-within:ring-primary/30 focus-within:border-primary/40 transition">
          <svg class="ml-3 w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input ref="searchInput" v-model="searchText" @input="onSearch" @focus="onSearch" @blur="setTimeout(() => showTagSuggestions = false, 200)" type="text"
            placeholder="搜索...      Ctrl + F"
            class="flex-1 min-w-0 px-2 py-1.5 bg-transparent border-0 text-sm outline-none placeholder-gray-400" />
          <!-- 清空搜索 -->
          <button v-if="searchText" @click="searchText = ''; store.searchQuery = ''; doSearch()" class="mr-2 text-gray-400 hover:text-gray-600 shrink-0">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <!-- 标签建议下拉 -->
          <div v-if="showTagSuggestions && tagSuggestions.length" class="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-[9999]">
            <button v-for="t in tagSuggestions" :key="t" @mousedown.prevent="addTag(t)"
              class="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 flex items-center gap-1.5">
              <span class="px-1.5 py-0.5 rounded-full text-[10px] bg-primary-light text-primary-dark">🏷️</span>
              {{ t }}
            </button>
          </div>
        </div>

        <!-- Mobile search toggle -->
        <button @click="showMobileSearch = !showMobileSearch" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 md:hidden">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>

        <!-- Filter toggle -->
        <button @click="toggleFilters" class="p-1.5 rounded-lg transition-colors hidden md:block"
          :class="showFilters || hasFilters ? 'bg-primary-light text-primary-dark' : 'hover:bg-gray-100 text-gray-400 hover:text-gray-600'">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Mobile search bar (expanded) -->
    <div v-if="showMobileSearch" class="px-3 pb-2 md:hidden">
      <div class="relative">
        <input v-model="searchText" @input="onSearch" type="text" placeholder="搜索..."
          class="w-full pl-9 pr-3 py-2 bg-gray-100/80 border-0 rounded-full text-sm outline-none focus:bg-white focus:ring-2 focus:ring-primary/30 placeholder-gray-400" autofocus />
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>
    </div>

    <!-- Desktop filter panel -->
    <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0 -translate-y-1"
      leave-active-class="transition duration-100 ease-in" leave-to-class="opacity-0 -translate-y-1">
      <div v-if="showFilters" class="px-6 pb-3 space-y-2 hidden md:block">
        <!-- 类型 + 时间 + 清除 -->
        <div class="flex items-center gap-3 h-7">
          <span class="text-xs text-gray-400 w-8 shrink-0">类型</span>
          <div class="flex items-center gap-1">
            <button v-for="t in typeOptions" :key="t.value" @click="toggleType(t.value)"
              class="px-2 py-0.5 rounded-full text-xs font-medium transition-colors"
              :class="filterTypes.includes(t.value) ? 'bg-primary-light text-primary-dark' : 'bg-gray-100 text-gray-400'">
              {{ t.icon }} {{ t.label }}
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
        <div class="flex items-center gap-1.5 flex-wrap h-7">
          <span class="text-xs text-gray-400 w-8 shrink-0">筛选</span>
          <span v-if="store.filterCategory" class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium"
            style="background: #FFE0CC; color: #D46B27">
            <span class="truncate max-w-[120px]">📂 {{ store.filterCategory }}</span>
            <button @click="clearCategory()" class="hover:opacity-60 shrink-0">×</button>
          </span>
          <span v-for="t in filterTags" :key="t" class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-primary-light text-primary-dark">
            🏷️ {{ t }}
            <button @click="removeTag(t)" class="hover:opacity-60">×</button>
          </span>
          <span v-if="!store.filterCategory && !filterTags.length" class="text-xs text-gray-300">无（侧边栏选分类，搜索栏输入匹配标签）</span>
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
          <button @click="showBatchMove = !showBatchMove" class="px-3 py-1 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100">
            移动分类
          </button>
          <div v-if="showBatchMove" class="absolute right-0 bottom-full mb-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-40 z-50">
            <button v-for="cat in categories" :key="cat.id"
              @click="store.batchMove(cat.name); showBatchMove = false"
              class="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
              📂 {{ cat.name }}
            </button>
            <div v-if="categories.length === 0" class="px-3 py-2 text-xs text-gray-400">无分类</div>
          </div>
        </div>
        <button @click="confirmBatchDelete ? (store.batchDelete(), confirmBatchDelete = false) : (confirmBatchDelete = true, setTimeout(() => confirmBatchDelete = false, 3000))"
          class="px-3 py-1 text-xs rounded-lg transition-colors"
          :class="confirmBatchDelete ? 'bg-red-500 text-white' : 'border border-gray-200 text-red-500 hover:bg-red-50'">
          {{ confirmBatchDelete ? '确认删除' : '删除' }}
        </button>
      </div>
    </div>
  </header>
</template>
