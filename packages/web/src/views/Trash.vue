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
    // Render markdown
    for (const n of res.data) {
      try { rendered.value[n.id] = await Vditor.md2html(n.content); } catch { rendered.value[n.id] = n.content; }
    }
  } catch {}
  loading.value = false;
}

async function restore(id: string) {
  try {
    await api.restoreNote(id);
    notes.value = notes.value.filter(n => n.id !== id);
  } catch {}
}

async function permanentDelete(id: string) {
  if (confirmDeleteId.value !== id) {
    confirmDeleteId.value = id;
    setTimeout(() => (confirmDeleteId.value = ''), 3000);
    return;
  }
  try {
    await api.permanentDeleteNote(id);
    notes.value = notes.value.filter(n => n.id !== id);
  } catch {}
  confirmDeleteId.value = '';
}

async function emptyAll() {
  if (!confirmEmpty.value) {
    confirmEmpty.value = true;
    setTimeout(() => (confirmEmpty.value = false), 3000);
    return;
  }
  try {
    await api.emptyTrash();
    notes.value = [];
  } catch {}
  confirmEmpty.value = false;
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
      <button @click="emptyAll"
        class="px-3 py-1.5 text-xs rounded-lg transition-colors"
        :class="confirmEmpty ? 'bg-red-500 text-white' : 'text-gray-400 hover:bg-red-50 hover:text-red-500'">
        {{ confirmEmpty ? '确认清空？' : '清空回收站' }}
      </button>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="notes.length === 0" class="text-center py-16">
      <div class="text-4xl mb-3">🗑️</div>
      <p class="text-gray-500 text-sm">回收站是空的</p>
      <p class="text-gray-400 text-xs mt-1">删除的笔记会在这里保留30天</p>
    </div>

    <div v-else class="space-y-3">
      <div v-for="n in notes" :key="n.id" class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden group">
        <div class="px-5 py-4">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-xs text-gray-400">{{ deletedAgo(n) }}</span>
            <span v-if="n.tags?.length" class="text-xs text-gray-300">
              {{ (n.tags as string[]).map(t => '#' + t).join(' ') }}
            </span>
          </div>
          <div class="prose prose-sm max-w-none text-gray-500 line-clamp-3 note-content" v-html="rendered[n.id] || n.content" />
        </div>
        <div class="flex items-center gap-1 px-4 py-2 border-t border-gray-50 opacity-0 group-hover:opacity-100 transition-opacity">
          <button @click="restore(n.id)" class="px-3 py-1 text-xs text-primary hover:bg-primary-light rounded-lg transition-colors">
            恢复
          </button>
          <button @click="permanentDelete(n.id)" class="px-3 py-1 text-xs ml-auto rounded-lg transition-colors"
            :class="confirmDeleteId === n.id ? 'text-red-500 bg-red-50 font-medium' : 'text-gray-400 hover:bg-red-50 hover:text-red-500'">
            {{ confirmDeleteId === n.id ? '确认永久删除？' : '永久删除' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.line-clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
