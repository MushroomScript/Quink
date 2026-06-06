import { ref, watch, onMounted, onBeforeUnmount, nextTick, type Ref } from 'vue';

// 瀑布流: N 个列,新卡片放到"当前真实 DOM 最矮列",长期保持列高平衡.
//
// 配合 CSS: .notes-masonry { display: flex } + .masonry-col-wrapper > .masonry-col
// 跟 useInfiniteScroll + view 的 push 模式一起用,scrollTop 不跳.
//
// 列高来源(优先级):
//   1. 真实 DOM offsetHeight(rootRef 可用时, 通过 querySelectorAll 拿) - 精确
//   2. estimateHeight 累计(rebuild 时 DOM 还没 mount 的兜底) - 估算误差大(含图片/markdown/音频卡片差 30%+)
//
// 触发"读真实高"的时机:
//   - rebuild 后 nextTick: 用真实值刷新 colHeights, 让下次 append 起点准确
//   - append(loadMore) 时: 直接读真实高度当 baseline, 配合 estimateHeight 给新加项做预测
//
// 老版本(纯 estimateHeight) bug: 含图片/markdown 卡片估算极低 → pickShortest 把"真实最高列"
// 当成"最矮列" → 新卡片继续往该列倒 → 列高越扯越歪. 真实测量解决这个反馈循环.
// 列数自适应: 用 masonry 容器实际宽度 (rootRef.clientWidth) 算, 不靠 viewport 推算.
// 之前 `viewport - sidebarW` 算法在 768px 临界点 sidebar 突然消失 (+240px 给主区) → 列数反弹
// (1100→3列, 770→1列, 760→2列, 559→1列) 蘑菇汇报"缩小过程中 2→1→2→1 反复跳".
// 直接读容器宽度天然避开这坑: sidebar 占不占位, masonry 容器宽度自动反映.
// 目标列宽 280px (保证 NoteCard chip 行能放下三点不被推出卡片外).
import { unzoomViewport } from '@/utils/zoom';

function getColumnCount(rootW?: number): number {
  const targetColW = 280;
  let main: number;
  if (rootW && rootW > 0) {
    main = rootW;
  } else {
    // fallback: rootRef 还没 attach 时 (onMounted 之前的初值), 用 viewport 粗估.
    // 这只在首次 setup 那帧用一次, onMounted 后立刻被真实 rootW 替代.
    const { vw } = unzoomViewport();
    main = vw >= 768 ? vw - 240 : vw;
  }
  const cols = Math.max(1, Math.floor(main / targetColW));
  return Math.min(cols, 5);
}

// 估算 NoteCard 渲染高度. line-clamp-4 限制文字 4 行, 但 block 元素(图片/代码块/附件)
// 不受 line-clamp 限制 → 单独估. 系数基于真实样本(NoteCard 内 .vditor-reset 渲染)反推:
// - 图片缩略图 ~200px / 张
// - 代码块 ~60px / 块 (4-5 行可见)
// - 附件按钮/音频胶囊 ~50px / 个
function estimateHeight(item: any): number {
  const content = item?.content || '';
  const charsPerLine = 40;
  const lines = Math.min(Math.ceil(content.length / charsPerLine), 4);
  let h = 80;
  h += lines * 22;
  if (item?.summary) h += 28;
  if (item?.tags?.length) h += 28;

  // 系数偏保守: 估算过激进会让 pickShortest 早期"封死"某列(把大估算卡集中分到一列后, 那列
  // 估算很高就再也不分配, 真实那列卡片少反而最矮). 宁可估算偏低让 pickShortest 多走 round-robin,
  // append 时 syncRealHeights 用真实 DOM 修正回来.
  const imgs = content.match(/!\[[^\]]*\]\([^)]+\.(?:png|jpe?g|gif|webp|heic|svg|bmp)[^)]*\)/gi);
  if (imgs) h += imgs.length * 100;

  const codeFences = (content.match(/```/g) || []).length;
  h += Math.floor(codeFences / 2) * 40;

  const attachments = content.match(/(?<!!)\[[^\]]*\]\([^)]+\.(?:mp4|mp3|m4a|wav|ogg|flac|pdf|docx?|xlsx?|pptx?|zip|rar|7z)[^)]*\)/gi);
  if (attachments) h += attachments.length * 30;

  return h;
}

function pickShortestCol(heights: number[]): number {
  let minIdx = 0;
  for (let i = 1; i < heights.length; i++) {
    if (heights[i] < heights[minIdx]) minIdx = i;
  }
  return minIdx;
}

export function useMasonry<T extends { id: string }>(
  getItems: () => T[],
  rootRef?: Ref<HTMLElement | null>
) {
  const columnCount = ref(getColumnCount());
  const columns = ref<T[][]>(Array.from({ length: columnCount.value }, () => []));
  // 每列累计列高估算(rebuild 时填充), append 前会被真实 DOM 高度覆盖
  const colHeights: number[] = new Array(columnCount.value).fill(0);
  // KeepAlive 后台 view 的 DOM 被 detach. 此时 rebuild() 走 measureCardHeights() querySelectorAll
  // 拿空 → 所有卡 estimateHeight 兜底 → pickShortestCol 全塞同一列 (蘑菇踩过的"塞同列" bug 根因).
  // 触发场景: filter-based computed (如 Todos pendingTodos = vs.notes.filter(...)) 在后台 view 的
  // vs.notes deep mutation 时重算返回新数组 → watch newItems !== oldItems → rebuild → detached.
  // 修法: rebuild 检测 root.isConnected, detached 时标 deferred + return; onActivated 时 view 主动调
  // flushDeferredRebuild() 触发补 rebuild, 此时 DOM 已 attach, measureCardHeights 拿真实高度正常分列.
  let deferredRebuild = false;

  function resetColHeights(n: number) {
    colHeights.length = 0;
    for (let i = 0; i < n; i++) colHeights.push(0);
  }

  // 从 rootRef 拿真实列高. rootRef 缺失/列数不匹配返回 null,调用者走估算兜底.
  // querySelector 用 :scope > .masonry-col-wrapper > .masonry-col,匹配新结构;
  // 兼容老结构 .notes-masonry > .masonry-col(Trash 等不带 wrapper 的场景).
  function measureRealHeights(): number[] | null {
    const root = rootRef?.value;
    if (!root) return null;
    let cols = root.querySelectorAll<HTMLElement>(':scope > .masonry-col-wrapper > .masonry-col');
    if (cols.length === 0) cols = root.querySelectorAll<HTMLElement>(':scope > .masonry-col');
    if (cols.length !== columnCount.value) return null;
    return Array.from(cols).map((c) => c.offsetHeight);
  }

  function syncRealHeights() {
    const real = measureRealHeights();
    if (!real) return;
    for (let i = 0; i < colHeights.length; i++) colHeights[i] = real[i];
  }

  // 拿当前 DOM 上所有 NoteCard 真实高度 (id → offsetHeight). NoteCard wrapper 带 [data-note-id].
  // 用于 rebuild 时 pickShortest 用真实高度而非 estimateHeight, 避免 refresh keepCount 全量替换
  // 走 rebuild 后用估算重排导致列高失衡 (实测 diff 从 20 飙到 414).
  function measureCardHeights(): Map<string, number> {
    const map = new Map<string, number>();
    const root = rootRef?.value;
    if (!root) return map;
    root.querySelectorAll<HTMLElement>('[data-note-id]').forEach((el) => {
      const id = el.dataset.noteId;
      if (id) map.set(id, el.offsetHeight);
    });
    return map;
  }

  function rebuild() {
    // detached DOM 检测: KeepAlive 后台 view 的 root 被 detach. 此时 rebuild 会让 measureCardHeights
    // 全部拿不到 → estimateHeight 偏低 → pickShortest 塞同一列. 改打 deferred, 等下次 onActivated
    // 时 view 调 flushDeferredRebuild() 补做 (那时 root 已 connected, 真实高度可用).
    const root = rootRef?.value;
    if (root && !root.isConnected) {
      deferredRebuild = true;
      return;
    }
    const n = columnCount.value;
    const cols: T[][] = Array.from({ length: n }, () => []);
    resetColHeights(n);
    // 复用 DOM 上已存在的卡片真实高度; 新卡(没 DOM)走 estimateHeight 兜底.
    // refresh keepCount 场景下大部分卡 id 不变 → 真实高度命中率高 → 重排后列高跟之前接近.
    const realMap = measureCardHeights();
    getItems().forEach((item) => {
      const idx = pickShortestCol(colHeights);
      cols[idx].push(item);
      const id = (item as any).id;
      colHeights[idx] += realMap.get(id) ?? estimateHeight(item);
    });
    columns.value = cols;
    deferredRebuild = false;
    // 即使 rebuild 用了真实高度, append 新卡的 estimate 偏差仍可能积累, nextTick 再 sync 一次
    nextTick(syncRealHeights);
  }

  // detached 期间累积的 rebuild 请求 (e.g. 后台 view 接收 store 函数的 mutation 触发 filter computed
  // 重算 → watch trigger → rebuild → 被 detached 守卫拦下标 deferred). view 在 onActivated 调一次
  // 同步 detached 期间的累积变化, 此时 root 已 connected, rebuild 用真实高度正常分列.
  function flushDeferredRebuild() {
    if (deferredRebuild) {
      rebuild();
    }
  }

  function onResize() {
    const c = getColumnCount(rootRef?.value?.clientWidth);
    if (c !== columnCount.value) {
      columnCount.value = c;
      rebuild();
    }
  }

  // ResizeObserver 监听 masonry root 容器宽度变化: 比 window.resize 更准
  // (sidebar 折叠 / collapsed toggle / drawer 等不触发 window resize, 但 main 宽度变了 → ResizeObserver 抓到)
  let ro: ResizeObserver | null = null;

  onMounted(() => {
    // mount 后初值用真实 rootW 重算一次 (setup 那帧 rootRef 还没 attach 用 fallback)
    onResize();
    window.addEventListener('resize', onResize);
    if (rootRef?.value && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize);
      ro.observe(rootRef.value);
    }
    rebuild();
  });
  onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize);
    ro?.disconnect();
  });

  let lastLength = 0;
  let lastFirstId: string | undefined;

  watch(getItems, (newItems, oldItems) => {
    const replaced = oldItems !== undefined && newItems !== oldItems;
    if (replaced) {
      rebuild();
      lastLength = newItems.length;
      lastFirstId = newItems[0]?.id;
      return;
    }

    const firstId = newItems[0]?.id;
    const shrunk = newItems.length < lastLength;
    const firstChanged = firstId !== lastFirstId;

    if (shrunk) {
      const newIds = new Set(newItems.map((n) => n.id));
      let hasNewIds = false;
      for (const item of newItems) {
        let found = false;
        for (const col of columns.value) {
          if ((col as T[]).some((c) => (c as any).id === (item as any).id)) {
            found = true;
            break;
          }
        }
        if (!found) {
          hasNewIds = true;
          break;
        }
      }
      if (!hasNewIds) {
        // 真·删除: 走增量 splice
        for (let ci = 0; ci < columns.value.length; ci++) {
          const col = columns.value[ci] as T[];
          for (let i = col.length - 1; i >= 0; i--) {
            if (!newIds.has((col[i] as any).id)) {
              colHeights[ci] -= estimateHeight(col[i]);
              col.splice(i, 1);
            }
          }
        }
        // 删除后下一帧用真实高度修正,避免 estimateHeight 偏差累积影响后续 pickShortest
        nextTick(syncRealHeights);
        lastLength = newItems.length;
        lastFirstId = firstId;
        return;
      }
    }

    if (shrunk || firstChanged) {
      rebuild();
    } else if (newItems.length > lastLength) {
      // loadMore append: 先用真实 DOM 高度刷新 colHeights, 避免估算偏差累积导致 pickShortest 选错列
      syncRealHeights();
      for (let i = lastLength; i < newItems.length; i++) {
        const idx = pickShortestCol(colHeights);
        if (columns.value[idx]) {
          (columns.value[idx] as T[]).push(newItems[i]);
          // 新加项还没 mount, 用 estimateHeight 当临时预测, 让同批次后续 item pickShortest 不会
          // 都挤进同一列. 下次 append 前 syncRealHeights 会用真实高度覆盖, 偏差不累积.
          colHeights[idx] += estimateHeight(newItems[i]);
        }
      }
    }
    lastLength = newItems.length;
    lastFirstId = firstId;
  }, { deep: true, immediate: true });

  return { columns, columnCount, flushDeferredRebuild };
}
