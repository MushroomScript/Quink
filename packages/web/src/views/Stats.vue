<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, markRaw } from 'vue';
import { useRouter } from 'vue-router';
import { api, isLoggedIn } from '@/api';
import { useNotesStore } from '@/stores/notes';
import { unzoomRect } from '@/utils/zoom';

const router = useRouter();
const notesStore = useNotesStore();
import {
  PhLightbulb,
  PhNotePencil,
  PhCheckSquare,
  PhPaperclip,
  PhTag,
  PhTrash,
  PhCalendarCheck,
  PhCaretDown,
  PhCaretUp,
} from '@phosphor-icons/vue';
// ECharts: tree-shaking 只引 pie + tooltip + legend + canvas renderer(避免拉全量 echarts)
import { use } from 'echarts/core';
import { PieChart } from 'echarts/charts';
import { TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import VChart from 'vue-echarts';

use([PieChart, TooltipComponent, LegendComponent, CanvasRenderer]);

const stats = ref<any>({ totalNotes: 0, totalTodos: 0, pendingTodos: 0, dailyCounts: [], categoryDist: [], typeDist: [] });
const fileCount = ref(0);
const tagCount = ref(0);
const trashCount = ref(0);
const loading = ref(true);

// 命名约定: quink=灵感, note=笔记, todo=待办. link 类型已废弃删
const typeLabels: Record<string, string> = { quink: '灵感', note: '笔记', todo: '待办' };

function getTypeCount(type: string): number {
  return (stats.value.typeDist || []).find((t: any) => t.type === type)?.count || 0;
}

// 活跃天数 = dailyCounts 里有记录的天数(后端 GROUP BY date,自带 count>0 过滤)
const activeDays = computed(() => (stats.value.dailyCounts || []).length);

// 顶部卡片数字渐变马卡龙色: 浅马卡龙起色 → 中等饱和同色系末色,135deg 斜向更自然
// path 为 null 的卡片(活跃天数)点击不跳转,其余跳到对应 sidebar 入口 view
const topCards = computed(() => [
  { label: '灵感', count: getTypeCount('quink'), icon: markRaw(PhLightbulb), color: 'bg-blue-50 text-blue-600', gradient: 'linear-gradient(135deg, #A7C7FF, #6890E0)', path: '/quink' },
  { label: '笔记', count: getTypeCount('note'), icon: markRaw(PhNotePencil), color: 'bg-emerald-50 text-emerald-600', gradient: 'linear-gradient(135deg, #B5E8C8, #5BC589)', path: '/notes' },
  { label: '待办', count: getTypeCount('todo'), icon: markRaw(PhCheckSquare), color: 'bg-amber-50 text-amber-600', gradient: 'linear-gradient(135deg, #FFE4A0, #FBBF24)', path: '/todos' },
  { label: '资源', count: fileCount.value, icon: markRaw(PhPaperclip), color: 'bg-purple-50 text-purple-600', gradient: 'linear-gradient(135deg, #D4C5FF, #A78BFA)', path: '/resources' },
  { label: '标签', count: tagCount.value, icon: markRaw(PhTag), color: 'bg-sky-50 text-sky-600', gradient: 'linear-gradient(135deg, #BAE6FD, #38BDF8)', path: '/tags' },
  { label: '活跃天数', count: activeDays.value, icon: markRaw(PhCalendarCheck), color: 'bg-pink-50 text-pink-600', gradient: 'linear-gradient(135deg, #FBCFE8, #EC4899)', path: null },
  { label: '回收站', count: trashCount.value, icon: markRaw(PhTrash), color: 'bg-gray-100 text-gray-500', gradient: 'linear-gradient(135deg, #E5E7EB, #9CA3AF)', path: '/trash' },
]);

// 命名约定: quinkCount=灵感, noteCount=笔记. link 类型已删
type CellData = { date: string; day: number; count: number; quinkCount: number; noteCount: number; todoCount: number };

const heatmapData = computed(() => {
  const map = new Map<string, Omit<CellData, 'date' | 'day'>>();
  for (const d of stats.value.dailyCounts || []) {
    map.set(d.date, { count: d.count, quinkCount: d.quinkCount || 0, noteCount: d.noteCount || 0, todoCount: d.todoCount || 0 });
  }
  const today = new Date();
  const weeks: CellData[][] = [];
  for (let w = 51; w >= 0; w--) {
    const week: CellData[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() - w * 7 - (today.getDay() - d));
      const dateStr = date.toISOString().slice(0, 10);
      const entry = map.get(dateStr);
      week.push({
        date: dateStr,
        day: d,
        count: entry?.count || 0,
        quinkCount: entry?.quinkCount || 0,
        noteCount: entry?.noteCount || 0,
        todoCount: entry?.todoCount || 0,
      });
    }
    weeks.push(week);
  }
  return weeks;
});

// 热力图 cell hover tooltip(fixed + Teleport,Teleport 到 body 跨过祖先容器)
type TooltipPart = { label: string; count: number };
const tooltip = ref<{ visible: boolean; date: string; parts: TooltipPart[]; top: string; left: string }>({
  visible: false, date: '', parts: [], top: '0px', left: '0px',
});
function onCellEnter(e: MouseEvent, cell: CellData) {
  // 无记录的天不弹 tooltip(空白 cell 没信息可显示)
  if (!cell.count) return;
  // unzoomRect: CSS zoom 下 tooltip 位置归一坐标系防错位
  const rect = unzoomRect(e.currentTarget as HTMLElement);
  const parts: TooltipPart[] = [];
  if (cell.quinkCount) parts.push({ label: '灵感', count: cell.quinkCount });
  if (cell.noteCount) parts.push({ label: '笔记', count: cell.noteCount });
  if (cell.todoCount) parts.push({ label: '待办', count: cell.todoCount });
  tooltip.value = {
    visible: true,
    date: cell.date,
    parts,
    top: `${rect.top - 8}px`,
    left: `${rect.left + rect.width / 2}px`,
  };
}
function onCellLeave() { tooltip.value.visible = false; }

// 点 cell: 有记录的天跳到灵感页并按该日筛选(query.date 由 Inspiration.vue 接收 + 派 quink-filter-date 给 TopBar 同步 chip)
// 空 cell 不响应,避免跳过去空列表
function onCellClick(cell: CellData) {
  if (!cell.count) return;
  tooltip.value.visible = false;
  router.push({ path: '/quink', query: { date: cell.date } });
}

// 项目自有调色板(13 色,避免 10 色循环重复)
const PIE_COLORS = ['#748cfc', '#5eceac', '#fc9686', '#f0be50', '#a78bfa', '#8ca0b9', '#f472b6', '#38bdf8', '#fb923c', '#a3e635', '#34d399', '#f87171', '#fbbf24'];
const PIE_TOP_N = 10;  // 超过这个数量折叠为"其他 N 项"
const OTHERS_COLOR = '#cbd5e1';  // 灰色,跟主题彩色拉开区分
const PIE_LABEL_MIN_PCT = 4;  // 占比 < 此值的段不在圆环画 label(信息在右侧 list 里全)
const showAllCategories = ref(false);  // 点"其他 N 项"切换显示完整列表/圆环

// 分类分布数据(按 count desc 排序;>10 项折叠为 Top 10 + 其他 N 项,点击展开)
const categoryData = computed(() => {
  const raw = (stats.value.categoryDist || []).map((c: any) => ({ value: c.count as number, name: c.category as string }));
  if (!raw.length) return [] as any[];
  const total = raw.reduce((s: number, d: any) => s + d.value, 0) || 1;
  const sorted = [...raw].sort((a, b) => b.value - a.value);
  const shouldFold = sorted.length > PIE_TOP_N && !showAllCategories.value;
  if (!shouldFold) {
    return sorted.map((d: any, i: number) => {
      const color = PIE_COLORS[i % PIE_COLORS.length];
      const pct = (d.value / total) * 100;
      const showLbl = pct >= PIE_LABEL_MIN_PCT;
      return { ...d, pct, color, itemStyle: { color }, label: { show: showLbl }, labelLine: { show: showLbl }, isOthers: false };
    });
  }
  const top = sorted.slice(0, PIE_TOP_N);
  const rest = sorted.slice(PIE_TOP_N);
  const restValue = rest.reduce((s: number, d: any) => s + d.value, 0);
  const result = top.map((d: any, i: number) => {
    const color = PIE_COLORS[i % PIE_COLORS.length];
    const pct = (d.value / total) * 100;
    const showLbl = pct >= PIE_LABEL_MIN_PCT;
    return { ...d, pct, color, itemStyle: { color }, label: { show: showLbl }, labelLine: { show: showLbl }, isOthers: false };
  });
  const othersPct = (restValue / total) * 100;
  const showOthersLbl = othersPct >= PIE_LABEL_MIN_PCT;
  result.push({
    name: `其他 ${rest.length} 项`,
    value: restValue,
    pct: othersPct,
    color: OTHERS_COLOR,
    itemStyle: { color: OTHERS_COLOR },
    label: { show: showOthersLbl },
    labelLine: { show: showOthersLbl },
    isOthers: true,
  });
  return result;
});

function toggleShowAll() {
  showAllCategories.value = !showAllCategories.value;
  // 切换时清掉 hover 状态避免错位
  hoveredPieIdx.value = null;
}

// 点击分类(饼图段或右侧 list 项): 跟 sidebar 分类点击同效果 — 设 store filterCategory + 跳 /quink 灵感页
// "未分类" 传 sentinel '__uncategorized__', 后端走 IS NULL 筛; 其他真实分类名直接传字符串
function onCategoryClick(name: string) {
  notesStore.filterCategory = name === '未分类' ? '__uncategorized__' : name;
  notesStore.fetchNotes();
  router.push('/quink');
}

// 放开 "未分类" + 用户分类"其他" 都可筛 (前者走 sentinel, 后者是用户真实分类名 eq match).
// 仅 isOthers (折叠的"其他 N 项") 是多分类聚合, 没法单一筛, 保持不可点
function isClickableCategory(item: { name: string; isOthers?: boolean }): boolean {
  return !item.isOthers;
}

// chart 实例引用,用于 dispatchAction 联动右侧 list hover
const chartRef = ref<any>(null);
const hoveredPieIdx = ref<number | null>(null);

// 监听 [data-theme] 变化让 pieOption 重算颜色(label/border 跟主题切)
const themeRev = ref(0);
let themeObserver: MutationObserver | null = null;
const isDarkTheme = () => document.documentElement.dataset.theme === 'dark';

// Blinko 风格 ECharts pie 配置: borderRadius 10 四角圆角 + borderWidth 2 白线分隔
// label 只显示名字({b},百分比挪到右侧自定义 legend);去掉 ECharts 内置 legend(自己写右侧 list 双向联动)
const pieOption = computed(() => {
  themeRev.value;  // 触发 reactive 追踪
  const dark = isDarkTheme();
  return {
    color: PIE_COLORS,
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{
      name: '分类分布',
      type: 'pie',
      radius: ['40%', '70%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      itemStyle: {
        borderRadius: 10,
        borderColor: dark ? 'rgb(31, 41, 55)' : '#ffffff',
        borderWidth: 2,
        borderJoin: 'round',
      },
      label: {
        show: true,
        position: 'outer',
        formatter: '{b}',
        color: dark ? 'rgba(255,255,255,0.85)' : '#1f2937',
        fontSize: 11,
      },
      emphasis: {
        label: { show: true, fontSize: 13, fontWeight: 'bold' },
        itemStyle: { shadowBlur: 20, shadowColor: 'rgba(0,0,0,0.35)', shadowOffsetY: 2 },
        scale: true,
        scaleSize: 12,
        focus: 'self',
      },
      labelLine: { show: true, length: 18, length2: 14, smooth: true },
      labelLayout: { hideOverlap: true },
      data: categoryData.value,
    }],
  };
});

// 双向联动: 饼图 hover → 同步 hoveredPieIdx;右侧 list hover → dispatchAction 触发饼图 emphasis
function onChartMouseOver(params: any) {
  if (typeof params.dataIndex === 'number') hoveredPieIdx.value = params.dataIndex;
}
function onChartMouseOut() {
  hoveredPieIdx.value = null;
}
function onLegendEnter(i: number) {
  hoveredPieIdx.value = i;
  // vue-echarts: chartRef.value 暴露 dispatchAction
  chartRef.value?.dispatchAction?.({ type: 'highlight', seriesIndex: 0, dataIndex: i });
}
function onLegendLeave(i: number) {
  hoveredPieIdx.value = null;
  chartRef.value?.dispatchAction?.({ type: 'downplay', seriesIndex: 0, dataIndex: i });
}

// 当前数据集每日最大记录数,用于动态归一化(避免高密度用户全打到 alpha=1.0 颜色一致)
const maxDayCount = computed(() => {
  const counts = (stats.value.dailyCounts || []).map((d: any) => d.count as number);
  return counts.length ? Math.max(...counts) : 1;
});

function cellOpacity(count: number): string {
  if (count === 0) return '';
  // 在 --heatmap-low → --heatmap-high 之间按 normalized 插值
  // (变量在 style.css 定义,亮/暗主题各一套;暗主题深端是满色 accent 而非加黑,因为暗背景上"加黑"=失去对比度)
  // 对数缩放 + 按当前数据 max 归一化: 适应不同使用密度
  const max = maxDayCount.value;
  const normalized = Math.log(count + 1) / Math.log(max + 1);
  const darkPct = normalized * 100;
  return `color-mix(in srgb, var(--heatmap-low) ${100 - darkPct}%, var(--heatmap-high) ${darkPct}%)`;
}

async function load() {
  if (!isLoggedIn()) return;
  loading.value = true;
  try {
    const [statsRes, filesRes, tagsRes, trashRes] = await Promise.all([
      api.getStats(),
      api.getFiles().catch(() => ({ data: [] })),
      api.getTags().catch(() => ({ data: [] })),
      api.getTrash().catch(() => ({ data: [] })),
    ]);
    stats.value = statsRes.data;
    fileCount.value = filesRes.data.length;
    tagCount.value = tagsRes.data.length;
    trashCount.value = trashRes.data.length;
  } catch {}
  loading.value = false;
}

function onRefresh() { load(); }
onMounted(() => {
  load();
  window.addEventListener('quink-refresh', onRefresh);
  // 监听 [data-theme] 变化触发 ECharts pieOption 重算(主题切换时 legend/label/border 颜色跟随)
  themeObserver = new MutationObserver(() => { themeRev.value++; });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
});
onUnmounted(() => {
  window.removeEventListener('quink-refresh', onRefresh);
  themeObserver?.disconnect();
});
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <!-- 顶部卡片：灵感/笔记/待办/资源/标签/回收站/活跃天数;hover scale + shadow,relative+z-10 让浮起来盖到邻居上;点击跳对应 view(活跃天数 path=null 不跳) -->
      <div class="grid grid-cols-7 gap-3 mb-6">
        <div v-for="card in topCards" :key="card.label"
          class="bg-white rounded-xl border border-gray-200 p-3 flex flex-col items-center text-center relative transition-all duration-200 hover:scale-105 hover:shadow-md hover:z-[var(--z-sticky)]"
          :class="card.path ? 'cursor-pointer' : 'cursor-default'"
          @click="card.path && router.push(card.path)">
          <div class="w-8 h-8 rounded-lg flex items-center justify-center mb-2" :class="card.color">
            <component :is="card.icon" size="1.125rem" weight="fill" />
          </div>
          <div class="text-xl font-bold bg-clip-text text-transparent tabular-nums" :style="{ backgroundImage: card.gradient }">{{ card.count }}</div>
          <div class="text-[11px] text-gray-400 mt-0.5">{{ card.label }}</div>
        </div>
      </div>

      <!-- 热力图: container-type 让 cqw 单位生效,cell/gap/图例色块全部相对容器宽度等比缩放,容器变大不会"色块大间距没变挤" -->
      <div class="bg-white rounded-xl border border-gray-200 p-6 mb-6" style="container-type: inline-size">
        <h3 class="text-sm font-medium text-gray-800 mb-4">记录热力图</h3>
        <!-- 原 .overflow-x-auto 包裹层已删(grid minmax(0,1fr) 永不溢出,且其 overflow-x:auto 被隐式提升到 overflow-y:auto 导致 hover scale 触发滚动条) -->
        <div class="grid" style="grid-template-columns: repeat(52, minmax(0, 1fr)); gap: 0.3cqw">
          <template v-for="(week, wi) in heatmapData" :key="wi">
            <div class="flex flex-col" style="gap: 0.3cqw">
              <div v-for="cell in week" :key="cell.date"
                class="aspect-square heatmap-cell"
                :class="{ 'heatmap-cell-empty': !cell.count }"
                :style="{ background: cellOpacity(cell.count) || 'var(--heatmap-empty, #f1f5f9)', borderRadius: '25%' }"
                @mouseenter="onCellEnter($event, cell)"
                @mouseleave="onCellLeave()"
                @click="onCellClick(cell)" />
            </div>
          </template>
        </div>
        <!-- 图例用跟热力图相同的 grid 模板(52 列 + 0.3cqw gap),前 6 列填内容,剩余空:
             少=col1、4 色块=col2-5、多=col6,严格跟热力图前 6 列对齐 -->
        <div class="grid mt-3 text-gray-400"
          style="grid-template-columns: repeat(52, minmax(0, 1fr)); gap: 0.3cqw; font-size: 1cqw">
          <div class="flex items-center justify-center">少</div>
          <div class="bg-gray-100" style="aspect-ratio: 1; border-radius: 25%"></div>
          <div style="aspect-ratio: 1; border-radius: 25%; background: var(--heatmap-low)"></div>
          <div style="aspect-ratio: 1; border-radius: 25%; background: color-mix(in srgb, var(--heatmap-low), var(--heatmap-high))"></div>
          <div style="aspect-ratio: 1; border-radius: 25%; background: var(--heatmap-high)"></div>
          <div class="flex items-center justify-center">多</div>
        </div>
      </div>

      <!-- 分类分布环形图(ECharts pie) + 右侧自定义 legend(双向 hover 联动) -->
      <div class="bg-white rounded-xl border border-gray-200 p-6">
        <h3 class="text-sm font-medium text-gray-800 mb-4">分类分布</h3>
        <!-- justify-center: 整体居中(避免大屏拉伸);gap-y 给 hover scale 1.06 留缓冲不让相邻 item 撞 -->
        <div v-if="categoryData.length" class="flex items-center gap-8 justify-center flex-wrap">
          <VChart ref="chartRef" :option="pieOption" autoresize
            class="shrink-0" style="width: 440px; height: 380px"
            @mouseover="onChartMouseOver" @mouseout="onChartMouseOut"
            @click="(p: any) => p.componentType === 'series' && p.data && isClickableCategory(p.data) && onCategoryClick(p.data.name)" />
          <!-- 2 列网格;折叠态(Top 10)完全展开不滚动;展开"其他"显示全部时加 max-h + 滚动,卡片高度稳定;px-2 给 hover scale 1.06 留水平缓冲避免被 overflow 裁 -->
          <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 w-[320px] py-2 px-2"
            :class="{ 'max-h-[380px] overflow-y-auto scrollbar-hide': showAllCategories }">
            <div v-for="(item, i) in categoryData" :key="item.name"
              class="legend-item flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-md transition-all min-w-0"
              :class="{
                'legend-item-active': hoveredPieIdx === i,
                'legend-item-others': item.isOthers,
                'cursor-pointer': isClickableCategory(item) || item.isOthers,
                'cursor-default': !isClickableCategory(item) && !item.isOthers,
              }"
              @mouseenter="onLegendEnter(i)" @mouseleave="onLegendLeave(i)"
              @click="item.isOthers ? toggleShowAll() : (isClickableCategory(item) && onCategoryClick(item.name))">
              <span class="w-2 h-2 rounded-sm shrink-0" :style="{ background: item.color }" />
              <span class="text-gray-700 truncate flex-1">{{ item.name }}</span>
              <span class="text-gray-400 tabular-nums shrink-0">{{ item.pct.toFixed(0) }}%</span>
              <component v-if="item.isOthers" :is="PhCaretDown" size="0.75rem" weight="bold" class="text-gray-400 shrink-0" />
            </div>
            <!-- 已展开"其他"时,在列表末尾加一个"收起"按钮回到 Top 10 视图 -->
            <button v-if="showAllCategories && categoryData.length > PIE_TOP_N"
              @click="toggleShowAll()"
              class="col-span-2 flex items-center justify-center gap-1 text-xs text-gray-400 hover:text-gray-600 py-1.5 rounded-md transition-colors">
              <PhCaretUp size="0.75rem" weight="bold" />
              <span>收起</span>
            </button>
          </div>
        </div>
        <p v-else class="text-center py-4 text-gray-400 text-xs">暂无数据</p>
      </div>
    </template>

    <!-- 热力图 cell tooltip: Teleport 到 body 跨过祖先容器;每种类型一行,数字右对齐(tabular-nums 等宽避免抖) -->
    <Teleport to="body">
      <div v-if="tooltip.visible"
        class="fixed z-[var(--z-overlay)] pointer-events-none bg-gray-800 text-white text-xs px-3 py-2 rounded-lg shadow-lg whitespace-nowrap min-w-[7rem]"
        :style="{ top: tooltip.top, left: tooltip.left, transform: 'translate(-50%, -100%)' }">
        <div class="font-medium tabular-nums">{{ tooltip.date }}</div>
        <template v-if="tooltip.parts.length">
          <div v-for="p in tooltip.parts" :key="p.label" class="flex justify-between gap-3 mt-1 text-gray-300">
            <span>{{ p.label }}</span>
            <span class="tabular-nums">{{ p.count }}</span>
          </div>
        </template>
        <div v-else class="text-gray-300 mt-1">无记录</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 热力图 cell hover: 略放大 + 略提亮(transform/filter 不影响 grid layout, z-index 让悬浮的盖到邻居上) */
.heatmap-cell {
  position: relative;
  transition: transform 0.15s ease, filter 0.15s ease;
  cursor: var(--cur-pointer), pointer;
}
.heatmap-cell:hover {
  transform: scale(1.25);
  filter: brightness(1.12);
  z-index: 2;
}
/* 空 cell(无记录): 视觉保留放大反馈,但 cursor 为常态 + onCellClick 守住不响应点击 */
.heatmap-cell-empty {
  cursor: var(--cur-default), default;
}

/* 自定义 legend item: hover 时放大 + 浅背景,跟饼图扇形双向联动 */
.legend-item:hover,
.legend-item-active {
  transform: scale(1.06);
  background: rgba(0, 0, 0, 0.04);
}
[data-theme="dark"] .legend-item:hover,
[data-theme="dark"] .legend-item-active {
  background: rgba(255, 255, 255, 0.06);
}
[data-theme="dark"] .legend-item .text-gray-700 { color: rgba(255, 255, 255, 0.85); }
</style>
