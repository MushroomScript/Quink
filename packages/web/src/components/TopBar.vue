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
const filterTag = ref('');
const filterDateFrom = ref('');
const filterDateTo = ref(new Date().toISOString().slice(0, 10));
const allTags = ref<string[]>([]);
let searchTimer: ReturnType<typeof setTimeout>;

watch(() => route.path, () => {
  clearTimeout(searchTimer);
  searchText.value = '';
  filterTag.value = '';
  filterDateFrom.value = '';
  filterDateTo.value = new Date().toISOString().slice(0, 10);
  showFilters.value = false;
  showMobileSearch.value = false;
  if (store.selectMode) store.toggleSelectMode();
});

const detailTitle = inject<Ref<string>>('detailTitle', ref(''));
const title = computed(() => detailTitle.value || (route.meta.title as string) || '');
const hideSearch = computed(() => !!route.meta.hideSearch);
const hasFilters = computed(() => filterTag.value || filterDateFrom.value);

function doSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    store.searchQuery = searchText.value;
    store.fetchNotes({
      tag: filterTag.value || undefined,
      dateFrom: filterDateFrom.value || undefined,
      dateTo: filterDateFrom.value ? (filterDateTo.value || undefined) : undefined,
    });
  }, 300);
}

function onSearch() { doSearch(); }
function applyFilters() { doSearch(); }

function clearFilters() {
  filterTag.value = '';
  filterDateFrom.value = '';
  filterDateTo.value = new Date().toISOString().slice(0, 10);
  doSearch();
}

async function toggleFilters() {
  showFilters.value = !showFilters.value;
  if (showFilters.value && allTags.value.length === 0) {
    try { const res = await api.getTags(); allTags.value = res.data; } catch {}
  }
}

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
        <div class="relative hidden md:block">
          <input ref="searchInput" v-model="searchText" @input="onSearch" type="text" placeholder="搜索...  Ctrl+F"
            class="w-64 pl-9 pr-3 py-1.5 bg-gray-100/80 border-0 rounded-full text-sm outline-none focus:bg-white focus:ring-2 focus:ring-primary/30 transition placeholder-gray-400" />
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
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
      <div v-if="showFilters" class="px-6 pb-3 flex items-center gap-4 flex-wrap hidden md:flex">
        <div class="flex items-center gap-1.5">
          <span class="text-xs text-gray-400">标签</span>
          <select v-model="filterTag" @change="applyFilters" class="px-2 py-1 border border-gray-200 rounded-lg text-xs outline-none bg-white">
            <option value="">全部</option>
            <option v-for="t in allTags" :key="t" :value="t">#{{ t }}</option>
          </select>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-xs text-gray-400">时间</span>
          <input v-model="filterDateFrom" @change="applyFilters" type="date" class="px-2 py-1 border border-gray-200 rounded-lg text-xs outline-none bg-white" />
          <span class="text-xs text-gray-400">-</span>
          <input v-model="filterDateTo" @change="applyFilters" type="date" class="px-2 py-1 border border-gray-200 rounded-lg text-xs outline-none bg-white" />
        </div>
        <button v-if="hasFilters" @click="clearFilters" class="text-xs text-gray-400 hover:text-gray-600">清除筛选</button>
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
