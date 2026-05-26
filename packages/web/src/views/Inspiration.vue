<script setup lang="ts">
import { onActivated, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useNotesStore } from '@/stores/notes';
import NoteInput from '@/components/NoteInput.vue';
import MobileInput from '@/components/MobileInput.vue';
import NoteCard from '@/components/NoteCard.vue';
import { PhLightbulb } from '@phosphor-icons/vue';
import { fadeOutLeave, snapshotCards } from '@/utils/cardLeave';
import { useInfiniteScroll } from '@/composables/useInfiniteScroll';
import { useMasonry } from '@/composables/useMasonry';

defineOptions({ name: 'inspiration' });

const store = useNotesStore();
const route = useRoute();
const isMobile = ref(window.innerWidth < 768);
const sentinel = useInfiniteScroll(() => store.loadMore());
const { columns, columnCount } = useMasonry(() => store.notes);
// 每页拉的条数 = 列数 × 10(3 列 30, 4 列 40, 5 列 50),刚好一屏 10 行
watch(columnCount, (n) => { store.pageSize = n * 10; }, { immediate: true });

// 数据变更前主动 snapshot 所有卡片位置，避免 onLeave 钩子里拿到的是 v-if 切换后的错位坐标
watch(() => store.notes.length, () => snapshotCards(), { flush: 'sync' });

onActivated(() => {
  // 跨视图跳转: ?date=YYYY-MM-DD 从统计页热力图过来; ?tag=xxx 从笔记编辑器/标签云过来。
  // 两条线都只设 store + 派事件给 TopBar,数据由 TopBar 监听器 doSearch(true) 统一拉,
  // 避免"Inspiration 拉一次 + TopBar 又拉一次"的重复请求 + UI 闪烁。
  const dateQuery = route.query.date as string;
  if (dateQuery) {
    store.filterType = '';
    store.searchQuery = '';
    window.dispatchEvent(new CustomEvent('quink-filter-date', { detail: dateQuery }));
    return;
  }
  const tagQuery = route.query.tag as string;
  if (tagQuery) {
    store.filterType = '';
    store.searchQuery = '';
    window.dispatchEvent(new CustomEvent('quink-filter-tag', { detail: tagQuery }));
    return;
  }
  const needRefresh = store.filterType !== 'note';
  store.filterType = 'note';
  if (needRefresh) {
    store.searchQuery = '';
    store.fetchNotes();
  }
});
</script>

<template>
  <div class="px-4 md:px-8 py-4 md:py-6">
    <Transition name="editor-area">
      <div v-if="!store.isFiltering" class="editor-area-wrap mb-4 md:mb-6">
        <div>
          <MobileInput v-if="isMobile" />
          <NoteInput v-else default-type="note" />
        </div>
      </div>
    </Transition>

    <!-- 只在首次加载(notes 为空)时显示全屏 loading;loadMore 时不要切到这个分支,
         否则会 unmount 整个 .notes-masonry,remount 后 main 容器 scrollTop 自动回到 0 -->
    <div v-if="store.loading && store.notes.length === 0" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <div v-if="store.notes.length === 0" class="text-center py-16">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhLightbulb size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">还没有记录任何灵感</p>
        <p class="text-gray-400 text-xs mt-1">在上方输入框写下你的第一个闪念吧</p>
      </div>

      <div class="notes-masonry">
        <TransitionGroup v-for="(col, ci) in columns" :key="ci" tag="div"
          data-animated-list class="masonry-col" :css="false" @leave="fadeOutLeave">
          <NoteCard v-for="note in col" :key="note.id" :note="note" />
        </TransitionGroup>
      </div>

      <!-- 无限滚动 sentinel: 进入视口前 300px 触发 loadMore -->
      <div ref="sentinel" v-if="store.notes.length < store.total" class="text-center py-6 text-xs text-gray-400">
        {{ store.loading ? '加载中...' : '滚动加载更多' }}
      </div>
    </template>
  </div>
</template>
