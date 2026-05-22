import { ref, onMounted, onBeforeUnmount, watch } from 'vue';

// 列表末尾放一个 sentinel,IntersectionObserver 监测它进入视口前 300px 时触发 loadMore.
// 跟 useMasonry 配合: useMasonry 用 ref + 增量 push 不替换列数组引用,
// 配合 Inspiration/Notes 首屏 v-if loading 仅 notes.length===0 时触发(防止 loadMore 时整列表 unmount),
// 滚动位置天然保留.
export function useInfiniteScroll(loadMore: () => void | Promise<void>) {
  const sentinel = ref<HTMLElement | null>(null);
  let observer: IntersectionObserver | null = null;

  function attach() {
    detach();
    if (!sentinel.value) return;
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: '300px', threshold: 0 }
    );
    observer.observe(sentinel.value);
  }

  function detach() {
    observer?.disconnect();
    observer = null;
  }

  onMounted(attach);
  onBeforeUnmount(detach);
  watch(sentinel, attach);

  return sentinel;
}
