<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, markRaw } from 'vue';
import { api, isLoggedIn } from '@/api';
import {
  PhLightbulb,
  PhNotePencil,
  PhCheckSquare,
  PhPaperclip,
  PhTag,
  PhTrash,
} from '@phosphor-icons/vue';

const stats = ref<any>({ totalNotes: 0, totalTodos: 0, pendingTodos: 0, dailyCounts: [], categoryDist: [], typeDist: [] });
const fileCount = ref(0);
const tagCount = ref(0);
const trashCount = ref(0);
const loading = ref(true);

const typeLabels: Record<string, string> = { note: '灵感', todo: '待办', snippet: '笔记', link: '链接' };

function getTypeCount(type: string): number {
  return (stats.value.typeDist || []).find((t: any) => t.type === type)?.count || 0;
}

const topCards = computed(() => [
  { label: '灵感', count: getTypeCount('note'), icon: markRaw(PhLightbulb), color: 'bg-blue-50 text-blue-600' },
  { label: '笔记', count: getTypeCount('snippet'), icon: markRaw(PhNotePencil), color: 'bg-emerald-50 text-emerald-600' },
  { label: '待办', count: getTypeCount('todo'), icon: markRaw(PhCheckSquare), color: 'bg-amber-50 text-amber-600' },
  { label: '资源', count: fileCount.value, icon: markRaw(PhPaperclip), color: 'bg-purple-50 text-purple-600' },
  { label: '标签', count: tagCount.value, icon: markRaw(PhTag), color: 'bg-sky-50 text-sky-600' },
  { label: '回收站', count: trashCount.value, icon: markRaw(PhTrash), color: 'bg-gray-100 text-gray-500' },
]);

const heatmapData = computed(() => {
  const countMap = new Map<string, number>();
  for (const d of stats.value.dailyCounts || []) countMap.set(d.date, d.count);
  const today = new Date();
  const weeks: { date: string; count: number; day: number }[][] = [];
  for (let w = 51; w >= 0; w--) {
    const week: { date: string; count: number; day: number }[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() - w * 7 - (today.getDay() - d));
      const dateStr = date.toISOString().slice(0, 10);
      week.push({ date: dateStr, count: countMap.get(dateStr) || 0, day: d });
    }
    weeks.push(week);
  }
  return weeks;
});

const PIE_COLORS = ['#748cfc', '#5eceac', '#fc9686', '#f0be50', '#a78bfa', '#8ca0b9', '#f472b6', '#38bdf8', '#fb923c', '#a3e635'];

function pieSlices(data: { name: string; count: number }[]): { name: string; count: number; pct: number; color: string; offset: number }[] {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (!total) return [];
  let offset = 0;
  return data.map((d, i) => {
    const pct = d.count / total * 100;
    const slice = { name: d.name, count: d.count, pct, color: PIE_COLORS[i % PIE_COLORS.length], offset };
    offset += pct;
    return slice;
  });
}

function pieGradient(slices: { pct: number; color: string; offset: number }[]): string {
  if (!slices.length) return 'var(--heatmap-empty, #f1f5f9)';
  const stops = slices.map(s => `${s.color} ${s.offset}% ${s.offset + s.pct}%`);
  return `conic-gradient(${stops.join(', ')})`;
}

const categorySlices = computed(() => {
  const data = (stats.value.categoryDist || []).map((c: any) => ({ name: c.category, count: c.count }));
  return pieSlices(data);
});

const tagSlices = computed(() => {
  const typeDist = (stats.value.typeDist || []).map((t: any) => ({ name: typeLabels[t.type] || t.type, count: t.count }));
  return pieSlices(typeDist);
});

function cellOpacity(count: number): string {
  if (count === 0) return '';
  const alpha = Math.min(0.25 + count * 0.2, 1);
  return `rgba(var(--c-accent) / ${alpha})`;
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
onMounted(() => { load(); window.addEventListener('quink-refresh', onRefresh); });
onUnmounted(() => { window.removeEventListener('quink-refresh', onRefresh); });
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <!-- 顶部卡片：灵感/笔记/待办 -->
      <div class="grid grid-cols-6 gap-3 mb-6">
        <div v-for="card in topCards" :key="card.label" class="bg-white rounded-xl border border-gray-200 p-3 flex flex-col items-center text-center">
          <div class="w-8 h-8 rounded-lg flex items-center justify-center mb-2" :class="card.color">
            <component :is="card.icon" size="1.125rem" weight="fill" />
          </div>
          <div class="text-xl font-bold text-gray-800">{{ card.count }}</div>
          <div class="text-[11px] text-gray-400 mt-0.5">{{ card.label }}</div>
        </div>
      </div>

      <!-- 热力图 -->
      <div class="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h3 class="text-sm font-medium text-gray-800 mb-4">记录热力图</h3>
        <div class="overflow-x-auto">
          <div class="grid gap-[3px]" style="grid-template-columns: repeat(52, minmax(0, 1fr))">
            <template v-for="(week, wi) in heatmapData" :key="wi">
              <div class="flex flex-col gap-[3px]">
                <div v-for="cell in week" :key="cell.date"
                  class="aspect-square"
                  style="border-radius: 25%"
                  :style="{ background: cellOpacity(cell.count) || 'var(--heatmap-empty, #f1f5f9)' }"
                  :title="`${cell.date}: ${cell.count} 条`" />
              </div>
            </template>
          </div>
        </div>
        <div class="flex items-center gap-1.5 mt-3 text-[10px] text-gray-400">
          <span>少</span>
          <div class="w-3 h-3 rounded-sm bg-gray-100"></div>
          <div class="w-3 h-3 rounded-sm" style="background: rgb(var(--c-accent) / 0.3)"></div>
          <div class="w-3 h-3 rounded-sm" style="background: rgb(var(--c-accent) / 0.6)"></div>
          <div class="w-3 h-3 rounded-sm" style="background: rgb(var(--c-accent))"></div>
          <span>多</span>
        </div>
      </div>

      <!-- 分类分布饼图 -->
      <div class="bg-white rounded-xl border border-gray-200 p-6">
        <h3 class="text-sm font-medium text-gray-800 mb-4">分类分布</h3>
        <div v-if="categorySlices.length" class="flex items-center gap-8 justify-center">
          <div class="w-40 h-40 rounded-full shrink-0" :style="{ background: pieGradient(categorySlices) }" />
          <div class="space-y-1.5">
            <div v-for="s in categorySlices" :key="s.name" class="flex items-center gap-2 text-xs">
              <span class="w-2.5 h-2.5 rounded-sm shrink-0" :style="{ background: s.color }" />
              <span class="text-gray-600 truncate" style="max-width: 120px">{{ s.name }}</span>
              <span class="text-gray-400">{{ s.count }}</span>
              <span class="text-gray-300 w-10 text-right">{{ s.pct.toFixed(0) }}%</span>
            </div>
          </div>
        </div>
        <p v-else class="text-center py-4 text-gray-400 text-xs">暂无数据</p>
      </div>
    </template>
  </div>
</template>
