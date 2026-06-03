<script setup lang="ts">
import { onActivated, onDeactivated, nextTick, ref, watch } from 'vue';
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

// 拿专属 ViewState (notes/total/currentPage/scrollTop/lastExtra). 不通过 store.notes 共享接口
// 是因为切 view 时 store.notes computed 会重算, KeepAlive 缓存的 view 内 useMasonry watch 会
// 被误触发 → columns 错位 rebuild. 走 viewState.inspiration.notes 引用稳定,只有本 view 数据
// 变化时触发, 其他 view 切换不打扰.
const vs = store.getViewState('inspiration');

const sentinels = ref<Array<HTMLElement | null>>([]);
useInfiniteScroll(() => store.loadMore(), sentinels);
const masonryRoot = ref<HTMLElement | null>(null);
const { columns, columnCount, flushDeferredRebuild } = useMasonry(() => vs.notes, masonryRoot);
// 每页拉的条数 = 列数 × 10(3 列 30, 4 列 40, 5 列 50),刚好一屏 10 行
watch(columnCount, (n) => { store.pageSize = n * 10; }, { immediate: true });

// 数据变更前主动 snapshot 所有卡片位置，避免 onLeave 钩子里拿到的是 v-if 切换后的错位坐标
watch(() => vs.notes.length, () => snapshotCards(), { flush: 'sync' });

// view-local refresh: TopBar 顶部刷新按钮按当前 view 调对应函数. keepCount 保住 loadMore
// 加载的条数 + scrollTop 不跳, lastExtra 保留过滤条件.
async function viewRefresh() {
  await store.fetchNotes(undefined, { keepCount: true });
}

onActivated(() => {
  store.activeView = 'inspiration';
  store.currentRefresh = viewRefresh;
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
  store.filterType = 'note';
  // 首次进入(本 view 数据为空)才拉, 已有数据保留 (loadMore 拉到的 90 条 / 当前滚动状态都保留)
  const wasEmpty = vs.notes.length === 0;
  if (wasEmpty) {
    store.searchQuery = '';
    store.fetchNotes();
  } else if (vs.dirty) {
    // 跨 view 操作脏标记: DOM 可达后走 keepCount fetch 同步新增 / 删除, 详见 Todos.vue 同段注释
    viewRefresh();
  }
  // 后台期间累积的 useMasonry rebuild 请求 (filter computed 触发或 vs.notes deep mutation 触发)
  // 在 detached 时被 deferred, 这里 root 已 connected 补做一次, 用真实高度正常分列.
  flushDeferredRebuild();
  // nextTick 恢复 scrollTop (DOM 重显示后再设置, 否则 main 还没拿到本 view DOM)
  nextTick(() => {
    const main = document.querySelector<HTMLElement>('main');
    if (main && vs.scrollTop > 0) main.scrollTop = vs.scrollTop;
  });
});

onDeactivated(() => {
  // 记 scrollTop, 切回时恢复
  const main = document.querySelector<HTMLElement>('main');
  if (main) vs.scrollTop = main.scrollTop;
  // 防竞争: 切到别的 view 后 store.currentRefresh 已被新 view 注册,本 view 注销时
  // 不能无脑清掉新 view 的注册. 比较引用相等只清自己的
  if (store.currentRefresh === viewRefresh) store.currentRefresh = null;
});
</script>

<template>
  <div class="px-4 md:px-8 py-4 md:py-6">
    <!-- v-show 替代 v-if: selectMode 切换时 NoteInput 不 unmount, 避免 Vditor 异步初始化期间
         editor-area-wrap 高度为 0 → main scrollHeight 缩水 → scrollTop 被浏览器归零的退出多选回顶 bug -->
    <Transition name="editor-area">
      <div v-show="!store.isFiltering && !store.selectMode" class="editor-area-wrap mb-4 md:mb-6">
        <div>
          <MobileInput v-if="isMobile" default-type="note" />
          <NoteInput v-else default-type="note" />
        </div>
      </div>
    </Transition>

    <!-- 只在首次加载(notes 为空)时显示全屏 loading;loadMore 时不要切到这个分支,
         否则会 unmount 整个 .notes-masonry,remount 后 main 容器 scrollTop 自动回到 0 -->
    <div v-if="store.loading && vs.notes.length === 0" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <div v-if="vs.notes.length === 0" class="text-center py-16">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhLightbulb size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">还没有记录任何灵感</p>
        <p class="text-gray-400 text-xs mt-1">在上方输入框写下你的第一个闪念吧</p>
      </div>

      <div ref="masonryRoot" class="notes-masonry">
        <div v-for="(col, ci) in columns" :key="ci" class="masonry-col-wrapper">
          <TransitionGroup tag="div" data-animated-list class="masonry-col"
            :css="false" @leave="fadeOutLeave">
            <NoteCard v-for="note in col" :key="note.id" :note="note" />
          </TransitionGroup>
          <!-- 列底 sentinel: 任一列距视口底 < 视口高度 25% 时触发 loadMore -->
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
