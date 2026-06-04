<script setup lang="ts">
import { onActivated, onDeactivated, nextTick, ref, watch } from 'vue';
import { useNotesStore } from '@/stores/notes';
import NoteInput from '@/components/NoteInput.vue';
import MobileInput from '@/components/MobileInput.vue';
import NoteCard from '@/components/NoteCard.vue';
import { PhNotePencil } from '@phosphor-icons/vue';
import { fadeOutLeave, snapshotCards } from '@/utils/cardLeave';
import { useInfiniteScroll } from '@/composables/useInfiniteScroll';
import { useMasonry } from '@/composables/useMasonry';

defineOptions({ name: 'notes' });

const store = useNotesStore();
const isMobile = ref(window.innerWidth < 768);
// 详见 Inspiration.vue 同段注释 - 拿专属 ViewState 避免跨 view watch 误触发
const vs = store.getViewState('notes');

const sentinels = ref<Array<HTMLElement | null>>([]);
useInfiniteScroll(() => store.loadMore(), sentinels);
const masonryRoot = ref<HTMLElement | null>(null);
const { columns, columnCount, flushDeferredRebuild } = useMasonry(() => vs.notes, masonryRoot);
watch(columnCount, (n) => { store.pageSize = n * 10; }, { immediate: true });

async function viewRefresh() {
  await store.fetchNotes(undefined, { keepCount: true });
}

onActivated(() => {
  store.activeView = 'notes';
  store.currentRefresh = viewRefresh;
  store.filterType = 'snippet';
  const wasEmpty = vs.notes.length === 0;
  if (wasEmpty) {
    store.filterCategory = '';
    store.searchQuery = '';
    store.fetchNotes();
  } else if (vs.dirty) {
    // 跨 view 操作脏标记: DOM 可达后走 keepCount fetch 同步新增 / 删除, 详见 Todos.vue 同段注释
    viewRefresh();
  }
  // 后台期间累积的 useMasonry rebuild 请求 (detached 时被 deferred 拦下) 这里 root 已 connected 补做.
  flushDeferredRebuild();
  nextTick(() => {
    const main = document.querySelector<HTMLElement>('main');
    if (main && vs.scrollTop > 0) main.scrollTop = vs.scrollTop;
  });
});

onDeactivated(() => {
  const main = document.querySelector<HTMLElement>('main');
  if (main) vs.scrollTop = main.scrollTop;
  if (store.currentRefresh === viewRefresh) store.currentRefresh = null;
});

watch(() => vs.notes.length, () => snapshotCards(), { flush: 'sync' });
</script>

<template>
  <div class="px-4 md:px-8 py-4 md:py-6">
    <!-- v-show 替代 v-if: 详见 Inspiration.vue 同段注释 (退出多选 scrollTop 回顶 bug) -->
    <Transition name="editor-area">
      <div v-show="!store.isFiltering && !store.selectMode" class="editor-area-wrap mb-4 md:mb-6">
        <div>
          <MobileInput v-if="isMobile" default-type="snippet" />
          <NoteInput v-else default-type="snippet" />
        </div>
      </div>
    </Transition>

    <!-- 同 Inspiration.vue: 仅首次加载才整体显示 loading,避免 loadMore 时整列表 unmount → scrollTop 回顶 -->
    <div v-if="store.loading && vs.notes.length === 0" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <div v-if="vs.notes.length === 0" class="text-center py-16">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhNotePencil size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">还没有笔记</p>
        <p class="text-gray-400 text-xs mt-1">在上方输入框写下你的第一篇笔记吧</p>
      </div>

      <div ref="masonryRoot" class="notes-masonry">
        <div v-for="(col, ci) in columns" :key="ci" class="masonry-col-wrapper">
          <TransitionGroup tag="div" data-animated-list class="masonry-col"
            :css="false" @leave="fadeOutLeave">
            <NoteCard v-for="note in col" :key="note.id" :note="note" />
          </TransitionGroup>
          <div v-if="vs.notes.length < vs.total"
            :ref="(el) => (sentinels[ci] = el as HTMLElement | null)" class="col-sentinel" />
        </div>
      </div>

      <div v-if="vs.notes.length < vs.total" class="text-center py-6 text-xs text-gray-400">
        {{ store.loading ? '加载中...' : '滚动加载更多' }}
      </div>
    </template>
  </div>
</template>
