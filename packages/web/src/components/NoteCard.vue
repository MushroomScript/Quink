<script setup lang="ts">
import { ref, computed, inject, watchEffect } from 'vue';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { useNotesStore } from '@/stores/notes';
import type { Note } from '@/api';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

import { useRouter } from 'vue-router';
const props = defineProps<{ note: Note }>();
const store = useNotesStore();
const router = useRouter();
const openEditModal = inject<(note: Note) => void>('openEditModal');

function goDetail() { router.push(`/note/${props.note.id}`); }

function handleClick(e: MouseEvent) {
  // Ctrl+Click 进入选择模式并切换选中
  if (e.ctrlKey || e.metaKey) {
    if (!store.selectMode) store.toggleSelectMode();
    store.toggleSelect(props.note.id);
    return;
  }
  // 选择模式下点击切换选中
  if (store.selectMode) {
    store.toggleSelect(props.note.id);
    return;
  }
  goDetail();
}

const confirmDelete = ref(false);

const renderedContent = ref('');

// Markdown → HTML rendering with search highlight
import Vditor from 'vditor';

watchEffect(async () => {
  const content = props.note.content;
  try {
    let html = await Vditor.md2html(content);
    // 搜索关键词高亮
    const q = store.searchQuery;
    if (q && q.trim()) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(`(${escaped})`, 'gi'), '<mark class="search-highlight">$1</mark>');
    }
    renderedContent.value = html;
  } catch {
    renderedContent.value = content;
  }
});

const timeAgo = computed(() => dayjs(props.note.createdAt).fromNow());
const fullTime = computed(() => dayjs(props.note.createdAt).format('YYYY-MM-DD HH:mm'));

const typeLabels: Record<string, string> = { note: '灵感', todo: '待办', snippet: '代码片段', link: '链接' };
const typeColor: Record<string, string> = {
  note: 'bg-primary-light text-primary',
  todo: 'bg-amber-100 text-amber-600',
  snippet: 'bg-emerald-100 text-emerald-600',
  link: 'bg-sky-100 text-sky-600',
};

async function handleDelete() {
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    setTimeout(() => (confirmDelete.value = false), 3000);
    return;
  }
  await store.deleteNote(props.note.id);
}
</script>

<template>
  <div class="bg-white rounded-2xl shadow-sm hover:shadow-md transition-all duration-200 group"
    :class="{ 'ring-2 ring-primary/50': note.pinned, 'ring-2 ring-primary': store.selectedIds.has(note.id) }">
    <div class="px-3 py-3 md:px-5 md:py-4 cursor-pointer" @click="handleClick" @dblclick.prevent="openEditModal?.(note)">
      <div class="flex items-center gap-2 mb-2.5">
        <!-- Checkbox (visible in select mode or when selected) -->
        <div v-if="store.selectMode"
          class="w-4.5 h-4.5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors"
          :class="store.selectedIds.has(note.id) ? 'bg-primary border-primary' : 'border-gray-300'">
          <svg v-if="store.selectedIds.has(note.id)" class="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>
        </div>
        <span class="text-[11px] px-2 py-0.5 rounded-full font-medium" :class="typeColor[note.type]">
          {{ typeLabels[note.type] }}
        </span>
        <span v-if="note.category" class="text-xs text-gray-400">{{ note.category }}</span>
        <span class="ml-auto text-[11px] text-gray-400" :title="fullTime">{{ timeAgo }}</span>
      </div>

      <p v-if="note.summary" class="text-xs text-gray-500 mb-1.5 italic">{{ note.summary }}</p>
      <div class="prose prose-sm max-w-none text-gray-700 note-content line-clamp-4" v-html="renderedContent" />

      <div v-if="note.tags && note.tags.length > 0" class="flex flex-wrap gap-1.5 mt-3">
        <span v-for="tag in note.tags" :key="tag" class="text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
          #{{ tag }}
        </span>
      </div>
    </div>

    <div class="flex items-center gap-1 px-3 md:px-4 py-1.5 md:py-2 border-t border-gray-50 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
      <button @click="store.togglePin(note.id)" class="p-1.5 rounded-lg hover:bg-gray-100 text-xs text-gray-400 transition-colors" :title="note.pinned ? '取消置顶' : '置顶'">
        {{ note.pinned ? '📌' : '📍' }}
      </button>
      <button @click="openEditModal?.(note)" class="p-1.5 rounded-lg hover:bg-gray-100 text-xs text-gray-400 transition-colors" title="编辑">
        ✏️
      </button>
      <button v-if="note.type === 'todo'" @click="store.toggleTodo(note.id)" class="p-1.5 rounded-lg hover:bg-gray-100 text-xs transition-colors"
        :class="note.todoStatus === 'done' ? 'text-green-500' : 'text-gray-400'"
        :title="note.todoStatus === 'done' ? '标记未完成' : '标记完成'">
        {{ note.todoStatus === 'done' ? '✅' : '⬜' }}
      </button>
      <button @click="handleDelete" class="p-1.5 rounded-lg hover:bg-red-50 text-xs ml-auto transition-colors"
        :class="confirmDelete ? 'text-red-500 font-medium' : 'text-gray-400'">
        {{ confirmDelete ? '确认?' : '🗑️' }}
      </button>
    </div>
  </div>
</template>
