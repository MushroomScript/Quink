<script setup lang="ts">
import { onActivated, ref, watch } from 'vue';
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
const sentinel = useInfiniteScroll(() => store.loadMore());
const { columns, columnCount } = useMasonry(() => store.notes);
watch(columnCount, (n) => { store.pageSize = n * 10; }, { immediate: true });

onActivated(() => {
  const needRefresh = store.filterType !== 'snippet';
  store.filterType = 'snippet';
  if (needRefresh) {
    store.filterCategory = '';
    store.searchQuery = '';
    store.fetchNotes();
  }
});

// 数据变更前主动 snapshot 所有卡片位置，避免 onLeave 钩子里拿到的是 v-if 切换后的错位坐标
watch(() => store.notes.length, () => snapshotCards(), { flush: 'sync' });
</script>

<template>
  <div class="px-4 md:px-8 py-4 md:py-6">
    <Transition name="editor-area">
      <div v-if="!store.isFiltering && !store.selectMode" class="editor-area-wrap mb-4 md:mb-6">
        <div>
          <MobileInput v-if="isMobile" default-type="snippet" />
          <NoteInput v-else default-type="snippet" />
        </div>
      </div>
    </Transition>

    <!-- 同 Inspiration.vue: 仅首次加载才整体显示 loading,避免 loadMore 时整列表 unmount → scrollTop 回顶 -->
    <div v-if="store.loading && store.notes.length === 0" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <div v-if="store.notes.length === 0" class="text-center py-16">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhNotePencil size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">暂无笔记</p>
      </div>

      <div class="notes-masonry">
        <TransitionGroup v-for="(col, ci) in columns" :key="ci" tag="div"
          data-animated-list class="masonry-col" :css="false" @leave="fadeOutLeave">
          <NoteCard v-for="note in col" :key="note.id" :note="note" />
        </TransitionGroup>
      </div>

      <div ref="sentinel" v-if="store.notes.length < store.total" class="text-center py-6 text-xs text-gray-400">
        {{ store.loading ? '加载中...' : '滚动加载更多' }}
      </div>
    </template>
  </div>
</template>
