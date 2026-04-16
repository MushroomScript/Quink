<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { api, isLoggedIn } from '@/api';

const stats = ref<any>({ totalNotes: 0, totalTodos: 0, pendingTodos: 0, dailyCounts: [], categoryDist: [], typeDist: [] });
const loading = ref(true);
const heatmapCanvas = ref<HTMLCanvasElement>();

const cards = [
  { key: 'totalNotes', label: '总笔记', icon: '📝', color: 'bg-blue-50 text-blue-600' },
  { key: 'totalTodos', label: '总待办', icon: '✅', color: 'bg-amber-50 text-amber-600' },
  { key: 'pendingTodos', label: '待完成', icon: '⏳', color: 'bg-red-50 text-red-600' },
];
const typeLabels: Record<string, string> = { note: '灵感', todo: '待办', snippet: '笔记', link: '链接' };

async function load() {
  if (!isLoggedIn()) return;
  loading.value = true;
  try {
    const res = await api.getStats();
    stats.value = res.data;
    await nextTick();
    drawHeatmap();
  } catch {}
  loading.value = false;
}

function drawHeatmap() {
  const canvas = heatmapCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const cellSize = 12;
  const gap = 3;
  const weeks = 52;
  const days = 7;

  canvas.width = (cellSize + gap) * weeks + 40;
  canvas.height = (cellSize + gap) * days + 25;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const countMap = new Map<string, number>();
  for (const d of stats.value.dailyCounts || []) countMap.set(d.date, d.count);

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim() || '116 143 252';
  const [r, g, b] = accent.split(' ').map(Number);

  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - weeks * 7);

  ctx.font = '10px system-ui';
  let lastMonth = -1;

  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < days; d++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + w * 7 + d);
      const dateStr = date.toISOString().slice(0, 10);
      const count = countMap.get(dateStr) || 0;
      const x = w * (cellSize + gap) + 30;
      const y = d * (cellSize + gap);

      if (d === 0 && date.getMonth() !== lastMonth) {
        lastMonth = date.getMonth();
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(`${date.getMonth() + 1}月`, x, canvas.height - 4);
      }

      if (count === 0) {
        ctx.fillStyle = '#f1f5f9';
      } else {
        const alpha = Math.min(0.25 + count * 0.2, 1);
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      }

      ctx.beginPath();
      ctx.roundRect(x, y, cellSize, cellSize, 2);
      ctx.fill();
    }
  }

  // Day labels
  const dayLabels = ['日', '一', '二', '三', '四', '五', '六'];
  ctx.fillStyle = '#94a3b8';
  ctx.font = '9px system-ui';
  for (let d = 0; d < 7; d++) {
    if (d % 2 === 1) ctx.fillText(dayLabels[d], 2, d * (cellSize + gap) + cellSize - 1);
  }
}

function onRefresh() { load(); }
onMounted(() => { load(); window.addEventListener('quink-refresh', onRefresh); });
onUnmounted(() => { window.removeEventListener('quink-refresh', onRefresh); });
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <div class="grid grid-cols-3 gap-4 mb-6">
        <div v-for="card in cards" :key="card.key" class="bg-white rounded-xl border border-gray-200 p-5">
          <div class="w-10 h-10 rounded-lg flex items-center justify-center text-lg mb-3" :class="card.color">{{ card.icon }}</div>
          <div class="text-2xl font-bold text-gray-800">{{ stats[card.key] }}</div>
          <div class="text-xs text-gray-400 mt-1">{{ card.label }}</div>
        </div>
      </div>

      <!-- Heatmap -->
      <div class="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h3 class="text-sm font-medium text-gray-800 mb-4">记录热力图</h3>
        <div class="overflow-x-auto">
          <canvas ref="heatmapCanvas" class="block"></canvas>
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

      <!-- Distribution -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="bg-white rounded-xl border border-gray-200 p-6">
          <h3 class="text-sm font-medium text-gray-800 mb-4">分类分布</h3>
          <div v-if="stats.categoryDist?.length" class="space-y-2.5">
            <div v-for="cat in stats.categoryDist" :key="cat.category" class="flex items-center gap-3">
              <span class="text-xs text-gray-600 w-16 truncate" :title="cat.category">{{ cat.category }}</span>
              <div class="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
                <div class="h-full rounded-full" style="background: rgb(var(--c-accent))"
                  :style="{ width: `${Math.max(5, cat.count / stats.totalNotes * 100)}%` }"></div>
              </div>
              <span class="text-xs text-gray-400 w-6 text-right">{{ cat.count }}</span>
            </div>
          </div>
          <p v-else class="text-center py-4 text-gray-400 text-xs">暂无数据</p>
        </div>

        <div class="bg-white rounded-xl border border-gray-200 p-6">
          <h3 class="text-sm font-medium text-gray-800 mb-4">类型分布</h3>
          <div v-if="stats.typeDist?.length" class="space-y-2.5">
            <div v-for="t in stats.typeDist" :key="t.type" class="flex items-center gap-3">
              <span class="text-xs text-gray-600 w-16">{{ typeLabels[t.type] || t.type }}</span>
              <div class="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
                <div class="h-full rounded-full" style="background: rgb(var(--c-accent) / 0.7)"
                  :style="{ width: `${Math.max(5, t.count / stats.totalNotes * 100)}%` }"></div>
              </div>
              <span class="text-xs text-gray-400 w-6 text-right">{{ t.count }}</span>
            </div>
          </div>
          <p v-else class="text-center py-4 text-gray-400 text-xs">暂无数据</p>
        </div>
      </div>
    </template>
  </div>
</template>
