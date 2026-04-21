<script setup lang="ts">
import { ref, computed, inject, watchEffect } from 'vue';
import { useRouter } from 'vue-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { useNotesStore } from '@/stores/notes';
import type { Note } from '@/api';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const props = defineProps<{ note: Note }>();
const store = useNotesStore();
const router = useRouter();
const openEditModal = inject<(note: Note) => void>('openEditModal');

function handleClick(e: MouseEvent) {
  if (e.ctrlKey || e.metaKey) {
    // Ctrl+点击引用标签 → 跳转详情
    const ref = (e.target as HTMLElement).closest('.note-ref-link');
    if (ref) {
      e.preventDefault();
      e.stopPropagation();
      try {
        const href = ref.getAttribute('data-ref') || '';
        const refId = new URL(href, location.origin).searchParams.get('ref');
        if (refId) { router.push(`/note/${refId}`); return; }
      } catch {}
    }
    // Ctrl+点击空白区 → 选择模式
    if (!store.selectMode) store.toggleSelectMode();
    store.toggleSelect(props.note.id);
    return;
  }
  if (store.selectMode) {
    store.toggleSelect(props.note.id);
    return;
  }
  router.push(`/note/${props.note.id}`);
}
const showMenu = ref(false);
const confirmDelete = ref(false);

function askDelete() {
  showMenu.value = false;
  confirmDelete.value = true;
}

async function doDelete() {
  confirmDelete.value = false;
  await store.deleteNote(props.note.id);
}

const renderedContent = ref('');

// Markdown → HTML rendering with search highlight
import Vditor from 'vditor';

watchEffect(async () => {
  const content = props.note.content;
  try {
    // 任务列表:* [X] → - [x] (Vditor md2html 只认 - 开头的任务列表)
    let md = content.replace(/^\* \[([ xX])\]/gm, (_, c) => `- [${c.toLowerCase()}]`);
    // 引用链接:先在 Markdown 层面简化(旧数据可能有多行 label,Vditor 解析不了)
    const processed = md.replace(
      /\[([\s\S]*?)\]\((\/?[?&]ref=[^)]+)\)/g,
      (_: string, label: string, href: string) => {
        const clean = label.replace(/[\n\r#*`\[\]!>~]/g, ' ').trim().slice(0, 20) || '引用笔记';
        return `<span class="note-ref-link" data-ref="${href}">📌 ${clean}</span>`;
      }
    );
    let html = await Vditor.md2html(processed, { cdn: '/vditor' });
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

const typeLabels: Record<string, string> = { note: '灵感', todo: '待办', snippet: '笔记', link: '链接' };
const typeColor: Record<string, string> = {
  note: 'bg-primary-light text-primary',
  todo: 'bg-amber-100 text-amber-600',
  snippet: 'bg-emerald-100 text-emerald-600',
  link: 'bg-sky-100 text-sky-600',
};
</script>

<template>
  <div class="bg-white rounded-2xl shadow-sm hover:shadow-md transition-all duration-200 group relative"
    :class="{ 'ring-2 ring-primary/50': note.pinned, 'ring-2 ring-primary': store.selectedIds.has(note.id) }">
    <div class="px-3 py-2.5 md:px-4 md:py-3 cursor-pointer" @click="handleClick">
      <div class="flex items-center gap-2 mb-2">
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
        <!-- 三点菜单 -->
        <button @click.stop="showMenu = !showMenu"
          class="p-0.5 rounded-md text-gray-300 hover:text-gray-500 hover:bg-gray-100 transition-colors">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
          </svg>
        </button>
      </div>

      <p v-if="note.summary" class="text-xs text-gray-500 mb-1.5 italic">{{ note.summary }}</p>
      <div class="prose prose-sm max-w-none text-gray-700 note-content line-clamp-4" v-html="renderedContent" />

      <div v-if="note.tags && note.tags.length > 0" class="flex flex-wrap gap-1.5 mt-2">
        <span v-for="tag in note.tags" :key="tag" class="text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
          #{{ tag }}
        </span>
      </div>
    </div>

    <!-- 下拉菜单 -->
    <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
      leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0 scale-95">
      <div v-if="showMenu" class="absolute right-3 top-10 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 min-w-[100px]">
        <button @click.stop="store.togglePin(note.id); showMenu = false"
          class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
          {{ note.pinned ? '📌 取消置顶' : '📍 置顶' }}
        </button>
        <button @click.stop="openEditModal?.(note); showMenu = false"
          class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
          ✏️ 编辑
        </button>
        <button v-if="note.type === 'todo'" @click.stop="store.toggleTodo(note.id); showMenu = false"
          class="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors"
          :class="note.todoStatus === 'done' ? 'text-green-600 hover:bg-green-50' : 'text-gray-600 hover:bg-gray-50'">
          {{ note.todoStatus === 'done' ? '✅ 标记未完成' : '⬜ 标记完成' }}
        </button>
        <div class="border-t border-gray-100 my-0.5"></div>
        <button @click.stop="askDelete()"
          class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-red-50 hover:text-red-500 transition-colors">
          🗑️ 删除
        </button>
      </div>
    </Transition>

    <!-- 删除确认弹窗 -->
    <Teleport to="body">
      <div v-if="confirmDelete" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmDelete = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">确认删除</p>
          <p class="text-xs text-gray-400 mb-4">删除后将移入回收站</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmDelete = false"
              class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doDelete()"
              class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 菜单外部点击关闭 -->
    <Teleport to="body">
      <div v-if="showMenu" class="fixed inset-0 z-40" @click="showMenu = false" />
    </Teleport>
  </div>
</template>
