import { onMounted, onBeforeUnmount, watch, type Ref } from 'vue';

// 每列底部各放一个 sentinel,任一进入 root(滚动容器) + 下方 25% 区域就触发 loadMore.
// 之所以不用单 sentinel(放整个列表末尾): sentinel 在 DOM 流末尾意味着它贴在最长列下,
// 列高不齐时(尤其删除卡片后)短列已大片空白,但 sentinel 还在最长列底,要最长列也快触底
// 才触发,用户感觉"半天不加载". 改成每列各 1 个 sentinel 后,任一列底接近 root 底就触发,
// 短列空白能直接驱动加载. rootMargin 用 25% 即"列底距 root 底 < root 高度 25%"时触发.
//
// 关键: IO 的 root 必须是真正的滚动容器(<main>),不能用默认 viewport.
// 因为 sentinel 在 overflow-y:auto 的 main 内,被 main 的 clip rect 裁掉时
// 即使在 viewport 坐标范围内 isIntersecting 也是 false,而 rootMargin 扩展的是 root
// 不是 ancestor scroll container 的 clip — 用 viewport 当 root 时 rootMargin 完全无效.
function findScrollRoot(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur && cur !== document.documentElement) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === 'auto' || oy === 'scroll') return cur;
    cur = cur.parentElement;
  }
  return null;
}

export function useInfiniteScroll(
  loadMore: () => void | Promise<void>,
  sentinels: Ref<Array<HTMLElement | null>>
) {
  let observer: IntersectionObserver | null = null;

  function attach() {
    detach();
    const els = sentinels.value.filter((el): el is HTMLElement => !!el);
    if (els.length === 0) return;
    const root = findScrollRoot(els[0]);
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { root, rootMargin: '0px 0px 25% 0px', threshold: 0 }
    );
    els.forEach((el) => observer!.observe(el));
  }

  function detach() {
    observer?.disconnect();
    observer = null;
  }

  onMounted(attach);
  onBeforeUnmount(detach);
  watch(sentinels, attach, { deep: true });
}
