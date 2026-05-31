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
function getColumnCount(): number {
  const w = window.innerWidth;
  if (w >= 1800) return 5;
  if (w >= 1400) return 4;
  if (w >= 900) return 3;
  if (w >= 600) return 2;
  return 1;
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

  function rebuild() {
    const n = columnCount.value;
    const cols: T[][] = Array.from({ length: n }, () => []);
    resetColHeights(n);
    getItems().forEach((item) => {
      const idx = pickShortestCol(colHeights);
      cols[idx].push(item);
      colHeights[idx] += estimateHeight(item);
    });
    columns.value = cols;
    // rebuild 后下一帧用真实 DOM 高度刷新, 修正 estimateHeight 偏差
    nextTick(syncRealHeights);
  }

  function onResize() {
    const c = getColumnCount();
    if (c !== columnCount.value) {
      columnCount.value = c;
      rebuild();
    }
  }

  onMounted(() => {
    window.addEventListener('resize', onResize);
    rebuild();
  });
  onBeforeUnmount(() => window.removeEventListener('resize', onResize));

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

  return { columns, columnCount };
}
