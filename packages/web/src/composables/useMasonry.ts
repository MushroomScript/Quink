import { ref, watch, onMounted, onBeforeUnmount } from 'vue';

// vanilla 版 react-masonry-css 风格瀑布流:
// - round-robin: 第 i 张 → i % N 列
// - 第一行 [0, 1, 2] = 最新 3 张(按行排序,靠上越新)
// - 列内 vertical stack(紧凑无空隙)
//
// 关键: columns 用 ref + 增量 push,不用 computed!
// 因为 computed 每次重算返回全新数组引用,TransitionGroup 把它当作"整体替换",
// FLIP 算法跑一遍,滚动位置跳. 用 ref + 直接 mutation 让 Vue 只 diff 新增节点.
function getColumnCount(): number {
  const w = window.innerWidth;
  if (w >= 1800) return 5;
  if (w >= 1400) return 4;
  if (w >= 900) return 3;
  if (w >= 600) return 2;
  return 1;
}

export function useMasonry<T extends { id: string }>(getItems: () => T[]) {
  const columnCount = ref(getColumnCount());
  const columns = ref<T[][]>(Array.from({ length: columnCount.value }, () => []));

  // 全量重建(首次 / 切 view / search / 屏幕宽度变化)
  function rebuild() {
    const n = columnCount.value;
    const cols: T[][] = Array.from({ length: n }, () => []);
    getItems().forEach((item, i) => {
      cols[i % n].push(item);
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

  // 跟踪上次状态用于区分"增量 append" vs "整体替换"
  let lastLength = 0;
  let lastFirstId: string | undefined;

  watch(getItems, (newItems) => {
    const firstId = newItems[0]?.id;
    const shrunk = newItems.length < lastLength;
    const firstChanged = firstId !== lastFirstId;
    // 数据缩了(删除/清空)或第一条变了(新建插入头/切 view) → 全量重建
    if (shrunk || firstChanged) {
      rebuild();
    } else if (newItems.length > lastLength) {
      // loadMore 增量 append:push 到对应列(mutation,不替换 columns.value 引用,TransitionGroup 只 diff 新增节点)
      const n = columnCount.value;
      for (let i = lastLength; i < newItems.length; i++) {
        const col = i % n;
        if (columns.value[col]) {
          (columns.value[col] as T[]).push(newItems[i]);
        }
      }
    }
    // length 不变 + first 不变 → 中间编辑,不动 columns
    lastLength = newItems.length;
    lastFirstId = firstId;
  }, { deep: true, immediate: true });

  return { columns, columnCount };
}
