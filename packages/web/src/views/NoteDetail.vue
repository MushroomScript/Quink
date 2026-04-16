<script setup lang="ts">
import { ref, onMounted, computed, inject } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type Note } from '@/api';
import Vditor from 'vditor';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const route = useRoute();
const router = useRouter();
const note = ref<Note | null>(null);
const rendered = ref('');
const loading = ref(true);
const openEditModal = inject<(note: Note) => void>('openEditModal');

const typeLabels: Record<string, string> = { note: '灵感', todo: '待办', snippet: '代码片段', link: '链接' };

onMounted(async () => {
  const id = route.params.id as string;
  try {
    const res = await api.getNote(id);
    note.value = res.data;
    rendered.value = await Vditor.md2html(res.data.content);
  } catch {
    note.value = null;
  }
  loading.value = false;
});

function goBack() { router.back(); }
</script>

<template>
  <div class="px-8 py-6">
    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="!note" class="text-center py-16">
      <div class="text-4xl mb-3">📝</div>
      <p class="text-gray-500 text-sm">笔记不存在或已被删除</p>
      <button @click="goBack" class="mt-4 text-xs text-primary hover:underline">返回</button>
    </div>

    <div v-else class="max-w-screen-md">
      <!-- Header -->
      <div class="flex items-center gap-3 mb-6">
        <button @click="goBack" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" /></svg>
        </button>
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded-full font-medium bg-primary-light text-primary-dark">{{ typeLabels[note.type] }}</span>
          <span v-if="note.category" class="text-xs text-gray-400">{{ note.category }}</span>
        </div>
        <span class="text-xs text-gray-400 ml-auto">{{ dayjs(note.createdAt).format('YYYY-MM-DD HH:mm') }}</span>
        <button @click="openEditModal?.(note)" class="px-3 py-1 text-xs rounded-lg hover:bg-gray-100 text-gray-400" title="编辑">✏️ 编辑</button>
      </div>

      <!-- Tags -->
      <div v-if="note.tags?.length" class="flex flex-wrap gap-1.5 mb-4">
        <span v-for="tag in note.tags" :key="tag" class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">#{{ tag }}</span>
      </div>

      <!-- Content -->
      <div class="bg-white rounded-2xl shadow-sm p-8 note-content prose prose-sm max-w-none" v-html="rendered" />
    </div>
  </div>
</template>
