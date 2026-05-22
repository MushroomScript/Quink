import { ref, watch, onMounted, onBeforeUnmount } from 'vue';

// 瀑布流: N 个列,新卡片放到"当前累计估算高度最矮"的列,长期保持列高平衡.
// (跟 react-masonry-css 的 i%N round-robin 不同,后者末尾列高差可达一屏)
//
// 配合 CSS: .notes-masonry { display: flex } + .masonry-col { flex-direction: column }
// 跟 useInfiniteScroll + view 的 push 模式一起用,scrollTop 不跳.
function getColumnCount(): number {
  const w = window.innerWidth;
  if (w >= 1800) return 5;
  if (w >= 1400) return 4;
  if (w >= 900) return 3;
  if (w >= 600) return 2;
  return 1;
}

// 估算卡片渲染高度(像素).Note 类型字段假设: { content?, tags?, summary? }.
// 不带类型约束让 useMasonry<T> 保持通用,这里对缺失字段按 0 处理.
function estimateHeight(item: any): number {
  const charsPerLine = 40; // 标准字号每行约 40 中文字符
  const contentLen = (item?.content?.length || 0);
  const lines = Math.min(Math.ceil(contentLen / charsPerLine), 4); // line-clamp-4
  let h = 80;                              // 卡片框 + padding + 时间/类型行
  h += lines * 22;                         // 内容文字
  if (item?.summary) h += 28;              // summary 单独占一行
  if (item?.tags?.length) h += 28;         // tags 一行
  // 音频/图片等富媒体没估算进去,差异容忍范围内
  return h;
}

function pickShortestCol(heights: number[]): number {
  let minIdx = 0;
  for (let i = 1; i < heights.length; i++) {
    if (heights[i] < heights[minIdx]) minIdx = i;
  }
  return minIdx;
}

export function useMasonry<T extends { id: string }>(getItems: () => T[]) {
  const columnCount = ref(getColumnCount());
  const columns = ref<T[][]>(Array.from({ length: columnCount.value }, () => []));
  // 每列累计估算高度,用于选最矮列.普通数组(非 ref),仅在 watch 内 mutation,不需要响应式
  const colHeights: number[] = new Array(columnCount.value).fill(0);

  function resetColHeights(n: number) {
    colHeights.length = 0;
    for (let i = 0; i < n; i++) colHeights.push(0);
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

  watch(getItems, (newItems) => {
    const firstId = newItems[0]?.id;
    const shrunk = newItems.length < lastLength;
    const firstChanged = firstId !== lastFirstId;
    if (shrunk || firstChanged) {
      // 全量重建(数据缩了/换 view/搜索)
      rebuild();
    } else if (newItems.length > lastLength) {
      // loadMore 增量 append: 新卡片各自找最矮列,push 到 columns.value[col] mutation
      for (let i = lastLength; i < newItems.length; i++) {
        const idx = pickShortestCol(colHeights);
        if (columns.value[idx]) {
          (columns.value[idx] as T[]).push(newItems[i]);
          colHeights[idx] += estimateHeight(newItems[i]);
        }
      }
    }
    lastLength = newItems.length;
    lastFirstId = firstId;
  }, { deep: true, immediate: true });

  return { columns, columnCount };
}
