<script setup lang="ts">
import { onActivated, onDeactivated, computed, ref, nextTick, watch } from 'vue';
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
// 详见 Inspiration.vue 同段注释 - 拿专属 ViewState 避免跨 view watch 误触发
const vs = store.getViewState('todos');

// pending 每列底 + done 每列底都注册进同一个 sentinels 数组,任一进视口附近就 loadMore.
// pending 列空白触发 loadMore 是良性的(store 没更多时是 no-op),避免列高不齐时短列空白半天不加载
const sentinels = ref<Array<HTMLElement | null>>([]);
useInfiniteScroll(() => store.loadMore(), sentinels);

// 数据变更前主动 snapshot 所有卡片位置，避免 onLeave 钩子里拿到的是 v-if 切换后的错位坐标
watch(() => vs.notes.length, () => snapshotCards(), { flush: 'sync' });

// 待办完成态: everyone(每人完成) 看"我个人完成 OR 整条已结束"(超时/全员, 蘑菇 A: 超时做不了的也归已完成);
// 群级 / 私有待办看 todoStatus (现状不变)
function isTodoDone(n: any): boolean {
  if (n.todoGroupMode === 'everyone') return !!n.todoDoneSummary?.mine || !!n.todoDoneSummary?.groupDone;
  return n.todoStatus === 'done';
}
const pendingTodos = computed(() =>
  vs.notes.filter((n) => n.type === 'todo' && !isTodoDone(n))
);
const doneTodos = computed(() =>
  vs.notes.filter((n) => n.type === 'todo' && isTodoDone(n))
);
// TopBar 钩多类型时, vs.notes 会包含非 todo 卡片(server 按 types 返回). 单独一组显示, 不区分 pending/done.
const otherNotes = computed(() =>
  vs.notes.filter((n) => n.type !== 'todo')
);
const pendingMasonryRoot = ref<HTMLElement | null>(null);
const doneMasonryRoot = ref<HTMLElement | null>(null);
const otherMasonryRoot = ref<HTMLElement | null>(null);
const { columns: pendingColumns, columnCount, flushDeferredRebuild: flushPending } = useMasonry(() => pendingTodos.value, pendingMasonryRoot);
const { columns: doneColumns, flushDeferredRebuild: flushDone } = useMasonry(() => doneTodos.value, doneMasonryRoot);
const { columns: otherColumns, flushDeferredRebuild: flushOther } = useMasonry(() => otherNotes.value, otherMasonryRoot);
watch(columnCount, (n) => { store.pageSize = n * 10; }, { immediate: true });

// 屏蔽掉初次加载（fetchNotes 完成后）触发的全员 enter，只让用户操作触发的 enter 走动画
const animateEnter = ref(false);
function onEnter(el: Element, done: () => void) {
  if (!animateEnter.value) { done(); return; }
  fadeInEnter(el, done);
}

async function viewRefresh() {
  await store.fetchNotes(undefined, { keepCount: true });
}

onActivated(async () => {
  store.activeView = 'todos';
  store.currentRefresh = viewRefresh;
  animateEnter.value = false;
  store.filterType = 'todo';
  const wasEmpty = vs.notes.length === 0;
  if (wasEmpty) {
    store.searchQuery = '';
    await store.fetchNotes();
  } else if (vs.dirty) {
    // 跨 view 操作让这个 view 数据不全 (updateNote 改 type 把笔记搬过来时只标 dirty 不直接插).
    // 现在切回来 DOM 可达, 走 keepCount fetch 同步: 删消失的 + 拉新增的 push 末尾, useMasonry
    // 走 mutate 路径不 rebuild, 已有卡片零移动.
    await viewRefresh();
  }
  // 后台期间累积的 useMasonry rebuild 请求 (filter computed 触发, 详见 useMasonry.ts) 3 组各补一次.
  flushPending();
  flushDone();
  flushOther();
  await nextTick();
  animateEnter.value = true;
  const main = document.querySelector<HTMLElement>('main');
  if (main && vs.scrollTop > 0) main.scrollTop = vs.scrollTop;
});

onDeactivated(() => {
  const main = document.querySelector<HTMLElement>('main');
  if (main) vs.scrollTop = main.scrollTop;
  if (store.currentRefresh === viewRefresh) store.currentRefresh = null;
});
</script>

<template>
  <div class="px-4 md:px-8 py-4 md:py-6">
    <!-- v-show 替代 v-if: 详见 Inspiration.vue 同段注释 (退出多选 scrollTop 回顶 bug) -->
    <Transition name="editor-area">
      <div v-show="!store.isFiltering && !store.selectMode" class="editor-area-wrap mb-4 md:mb-6">
        <div>
          <MobileInput v-if="isMobile" default-type="todo" />
          <NoteInput v-else default-type="todo" />
        </div>
      </div>
    </Transition>

    <div :class="pendingTodos.length > 0 ? 'mb-6 md:mb-8' : ''">
      <h3 v-if="pendingTodos.length > 0" class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">未完成 ({{ pendingTodos.length }})</h3>
      <div ref="pendingMasonryRoot" class="notes-masonry">
        <div v-for="(col, ci) in pendingColumns" :key="ci" class="masonry-col-wrapper">
          <TransitionGroup tag="div" data-animated-list class="masonry-col"
            :css="false" @leave="fadeOutLeave" @enter="onEnter">
            <NoteCard v-for="note in col" :key="note.id" :note="note" />
          </TransitionGroup>
          <!-- pending 列底 sentinel: 索引 0..N-1 -->
          <div v-if="vs.notes.length < vs.total"
            :ref="(el) => (sentinels[ci] = el as HTMLElement | null)" class="col-sentinel" />
        </div>
      </div>
    </div>

    <div :class="doneTodos.length > 0 ? 'mb-6 md:mb-8' : ''">
      <h3 v-if="doneTodos.length > 0" class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">已完成 ({{ doneTodos.length }})</h3>
      <div ref="doneMasonryRoot" class="notes-masonry opacity-60">
        <div v-for="(col, ci) in doneColumns" :key="ci" class="masonry-col-wrapper">
          <TransitionGroup tag="div" data-animated-list class="masonry-col"
            :css="false" @leave="fadeOutLeave" @enter="onEnter">
            <NoteCard v-for="note in col" :key="note.id" :note="note" />
          </TransitionGroup>
          <!-- done 列底 sentinel: 固定偏移 +100 避免跟 pending 索引冲突.
               不用 columnCount + ci 是因为 columnCount 变化时 unmount 回调用新值,会写到错位
               索引导致旧 DOM ref 残留 → observer 泄漏. 固定偏移让 done 永远占 100..100+N. -->
          <div v-if="vs.notes.length < vs.total"
            :ref="(el) => (sentinels[100 + ci] = el as HTMLElement | null)" class="col-sentinel" />
        </div>
      </div>
    </div>

    <!-- 其他类型: TopBar 钩多类型时把非 todo 卡片显示出来. 仅在有数据时才显示分区标题/列表 -->
    <div v-if="otherNotes.length > 0">
      <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">其他类型 ({{ otherNotes.length }})</h3>
      <div ref="otherMasonryRoot" class="notes-masonry">
        <div v-for="(col, ci) in otherColumns" :key="ci" class="masonry-col-wrapper">
          <TransitionGroup tag="div" data-animated-list class="masonry-col"
            :css="false" @leave="fadeOutLeave" @enter="onEnter">
            <NoteCard v-for="note in col" :key="note.id" :note="note" />
          </TransitionGroup>
          <!-- other 列底 sentinel: 固定偏移 +200 避免跟 pending(0..N) / done(100..) 冲突 -->
          <div v-if="vs.notes.length < vs.total"
            :ref="(el) => (sentinels[200 + ci] = el as HTMLElement | null)" class="col-sentinel" />
        </div>
      </div>
    </div>

    <div v-if="vs.notes.length === 0 && !store.loading" class="empty-state-center">
      <div class="mb-3 flex justify-center text-gray-300">
        <PhCheckSquare size="3rem" weight="fill" />
      </div>
      <p class="text-gray-500 text-sm">还没有待办</p>
      <p class="text-gray-400 text-xs mt-1">在上方输入框创建一个待办吧</p>
    </div>

    <div v-if="vs.notes.length < vs.total" class="text-center py-6 text-xs text-gray-400">
      {{ store.loading ? '加载中...' : '滚动加载更多' }}
    </div>
  </div>
</template>
