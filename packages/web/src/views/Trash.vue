<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { api, isLoggedIn, type Note } from '@/api';
import Vditor from 'vditor';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const notes = ref<Note[]>([]);
const loading = ref(true);
const confirmEmpty = ref(false);
const confirmDeleteId = ref('');
const rendered = ref<Record<string, string>>({});

async function load() {
  if (!isLoggedIn()) return;
  loading.value = true;
  try {
    const res = await api.getTrash();
    notes.value = res.data;
    for (const n of res.data) {
      try { rendered.value[n.id] = await Vditor.md2html(n.content, { cdn: '/vditor' }); } catch { rendered.value[n.id] = n.content; }
    }
  } catch {}
  loading.value = false;
}

async function restore(id: string) {
  try { await api.restoreNote(id); notes.value = notes.value.filter(n => n.id !== id); } catch {}
}

async function doPermanentDelete() {
  const id = confirmDeleteId.value;
  confirmDeleteId.value = '';
  if (!id) return;
  try { await api.permanentDeleteNote(id); notes.value = notes.value.filter(n => n.id !== id); } catch {}
}

async function doEmptyAll() {
  confirmEmpty.value = false;
  try { await api.emptyTrash(); notes.value = []; } catch {}
}

function deletedAgo(n: any) {
  return n.deletedAt ? dayjs(n.deletedAt).fromNow() + '删除' : '';
}

function onRefresh() { load(); }
onMounted(() => { load(); window.addEventListener('quink-refresh', onRefresh); });
onUnmounted(() => { window.removeEventListener('quink-refresh', onRefresh); });
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <div class="flex items-center justify-between mb-6" v-if="notes.length > 0">
      <p class="text-xs text-gray-400">{{ notes.length }} 条已删除的笔记，30天后自动永久删除</p>
      <button @click="confirmEmpty = true" class="px-3 py-1.5 text-xs rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors">
        清空回收站
      </button>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="notes.length === 0" class="text-center py-16">
      <div class="text-4xl mb-3">🗑️</div>
      <p class="text-gray-500 text-sm">回收站是空的</p>
      <p class="text-gray-400 text-xs mt-1">删除的笔记会在这里保留30天</p>
    </div>

    <div v-else class="notes-masonry">
      <div v-for="n in notes" :key="n.id" class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden group">
        <div class="px-4 py-3">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-xs text-gray-400">{{ deletedAgo(n) }}</span>
            <span v-if="n.tags?.length" class="text-xs text-gray-300">
              {{ (n.tags as string[]).map(t => '#' + t).join(' ') }}
            </span>
          </div>
          <div class="prose prose-sm max-w-none text-gray-500 line-clamp-4 note-content" v-html="rendered[n.id] || n.content" />
        </div>
        <div class="flex items-center gap-1 px-3 py-2 border-t border-gray-50 opacity-0 group-hover:opacity-100 transition-opacity">
          <button @click="restore(n.id)" class="px-3 py-1 text-xs text-primary hover:bg-primary-light rounded-lg transition-colors">
            恢复
          </button>
          <button @click="confirmDeleteId = n.id" class="px-3 py-1 text-xs ml-auto rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors">
            永久删除
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 永久删除确认弹窗 -->
  <Teleport to="body">
    <div v-if="confirmDeleteId" class="fixed inset-0 z-[200] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" @click="confirmDeleteId = ''" />
      <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
        <p class="text-sm text-gray-700 mb-1">永久删除</p>
        <p class="text-xs text-gray-400 mb-4">此操作不可恢复</p>
        <div class="flex gap-2 justify-center">
          <button @click="confirmDeleteId = ''" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
          <button @click="doPermanentDelete" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">永久删除</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 清空回收站确认弹窗 -->
  <Teleport to="body">
    <div v-if="confirmEmpty" class="fixed inset-0 z-[200] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" @click="confirmEmpty = false" />
      <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
        <p class="text-sm text-gray-700 mb-1">清空回收站</p>
        <p class="text-xs text-gray-400 mb-4">将永久删除所有 {{ notes.length }} 条笔记，不可恢复</p>
        <div class="flex gap-2 justify-center">
          <button @click="confirmEmpty = false" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
          <button @click="doEmptyAll" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">清空</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.line-clamp-4 {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
