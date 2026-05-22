<script setup lang="ts">
import { onActivated, computed, ref, nextTick, watch } from 'vue';
import { useNotesStore } from '@/stores/notes';
import NoteInput from '@/components/NoteInput.vue';
import MobileInput from '@/components/MobileInput.vue';
import NoteCard from '@/components/NoteCard.vue';
import { PhCheckSquare } from '@phosphor-icons/vue';
import { fadeOutLeave, fadeInEnter, snapshotCards } from '@/utils/cardLeave';
import { useInfiniteScroll } from '@/composables/useInfiniteScroll';
import { useMasonry } from '@/composables/useMasonry';

defineOptions({ name: 'todos' });

const store = useNotesStore();
const isMobile = ref(window.innerWidth < 768);
const sentinel = useInfiniteScroll(() => store.loadMore());

// 数据变更前主动 snapshot 所有卡片位置，避免 onLeave 钩子里拿到的是 v-if 切换后的错位坐标
watch(() => store.notes.length, () => snapshotCards(), { flush: 'sync' });

const pendingTodos = computed(() =>
  store.notes.filter((n) => n.type === 'todo' && n.todoStatus !== 'done')
);
const doneTodos = computed(() =>
  store.notes.filter((n) => n.type === 'todo' && n.todoStatus === 'done')
);
const { columns: pendingColumns, columnCount } = useMasonry(() => pendingTodos.value);
const { columns: doneColumns } = useMasonry(() => doneTodos.value);
watch(columnCount, (n) => { store.pageSize = n * 10; }, { immediate: true });

// 屏蔽掉初次加载（fetchNotes 完成后）触发的全员 enter，只让用户操作触发的 enter 走动画
const animateEnter = ref(false);
function onEnter(el: Element, done: () => void) {
  if (!animateEnter.value) { done(); return; }
  fadeInEnter(el, done);
}

onActivated(async () => {
  animateEnter.value = false;
  const needRefresh = store.filterType !== 'todo';
  store.filterType = 'todo';
  if (needRefresh) {
    store.searchQuery = '';
    await store.fetchNotes();
  }
  await nextTick();
  animateEnter.value = true;
});
</script>

<template>
  <div class="px-4 md:px-8 py-4 md:py-6">
    <div class="mb-4 md:mb-6">
      <MobileInput v-if="isMobile" />
      <NoteInput v-else default-type="todo" />
    </div>

    <div :class="pendingTodos.length > 0 ? 'mb-6 md:mb-8' : ''">
      <h3 v-if="pendingTodos.length > 0" class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">未完成 ({{ pendingTodos.length }})</h3>
      <div class="notes-masonry">
        <TransitionGroup v-for="(col, ci) in pendingColumns" :key="ci" tag="div"
          data-animated-list class="masonry-col" :css="false" @leave="fadeOutLeave" @enter="onEnter">
          <NoteCard v-for="note in col" :key="note.id" :note="note" />
        </TransitionGroup>
      </div>
    </div>

    <div>
      <h3 v-if="doneTodos.length > 0" class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">已完成 ({{ doneTodos.length }})</h3>
      <div class="notes-masonry opacity-60">
        <TransitionGroup v-for="(col, ci) in doneColumns" :key="ci" tag="div"
          data-animated-list class="masonry-col" :css="false" @leave="fadeOutLeave" @enter="onEnter">
          <NoteCard v-for="note in col" :key="note.id" :note="note" />
        </TransitionGroup>
      </div>
    </div>

    <div v-if="store.notes.length === 0 && !store.loading" class="text-center py-16">
      <div class="mb-3 flex justify-center text-gray-300">
        <PhCheckSquare size="3rem" weight="fill" />
      </div>
      <p class="text-gray-500 text-sm">还没有待办事项</p>
      <p class="text-gray-400 text-xs mt-1">在上方输入框创建一个待办吧</p>
    </div>

    <div ref="sentinel" v-if="store.notes.length < store.total" class="text-center py-6 text-xs text-gray-400">
      {{ store.loading ? '加载中...' : '滚动加载更多' }}
    </div>
  </div>
</template>
