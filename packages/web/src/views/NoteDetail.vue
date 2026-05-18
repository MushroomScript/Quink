<script setup lang="ts">
import { ref, onMounted, onUnmounted, inject, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useNotesStore } from '@/stores/notes';
import { api, type Note } from '@/api';
import Vditor from 'vditor';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { PhNotePencil, PhCaretLeft, PhPencilSimple } from '@phosphor-icons/vue';
import { REF_LINK_REGEX, renderRefLink } from '@/utils/refLink';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const route = useRoute();
const router = useRouter();
const store = useNotesStore();
const note = ref<Note | null>(null);
const rendered = ref('');
const loading = ref(true);
const openEditModal = inject<(note: Note, fullscreen?: boolean) => void>('openEditModal');
const detailTitle = inject<Ref<string>>('detailTitle');
const hasRefPreviewPending = inject<Ref<boolean>>('hasRefPreviewPending');
const restoreRefPreview = inject<() => void>('restoreRefPreview');

const typeLabels: Record<string, string> = { note: '灵感', todo: '待办', snippet: '笔记', link: '链接' };

async function loadNote() {
  const id = route.params.id as string;
  try {
    const res = await api.getNote(id);
    note.value = res.data;
    if (detailTitle) detailTitle.value = typeLabels[res.data.type] + '详情';
    try {
      let md = res.data.content.replace(/^\* \[([ xX])\]/gm, (_, c) => `- [${c.toLowerCase()}]`);
      const processed = md.replace(REF_LINK_REGEX, (_, label, href) => renderRefLink(label, href, 30));
      let html = await Vditor.md2html(processed, { cdn: '/vditor' });
      rendered.value = html;
    } catch (e) {
      console.error('[NoteDetail] Vditor render failed:', e);
      const esc = res.data.content
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      rendered.value = `<div style="white-space:pre-wrap">${esc}</div>`;
    }
  } catch (e) {
    console.error('[NoteDetail] load note failed:', e);
    note.value = null;
  }
  loading.value = false;
}

// 编辑保存后 store 里的笔记会更新，监听变化自动刷新
watch(() => store.notes, () => {
  if (note.value) {
    const updated = store.notes.find(n => n.id === note.value!.id);
    if (updated && updated.updatedAt !== note.value.updatedAt) {
      note.value = updated;
      let md = updated.content.replace(/^\* \[([ xX])\]/gm, (_, c) => `- [${c.toLowerCase()}]`);
      md = md.replace(REF_LINK_REGEX, (_, label, href) => renderRefLink(label, href, 30));
      Vditor.md2html(md, { cdn: '/vditor' }).then(html => { rendered.value = html; });
    }
  }
}, { deep: true });

function goBack() {
  // 有预览栈等待恢复 → 先显示预览,不导航
  if (hasRefPreviewPending?.value) {
    restoreRefPreview?.();
    return;
  }
  if (window.history.length > 1) {
    router.back();
  } else {
    router.push('/');
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') goBack();
}

onMounted(() => { document.addEventListener('keydown', onKeydown); loadNote(); });
watch(() => route.params.id, () => { loadNote(); });
onUnmounted(() => {
  if (detailTitle) detailTitle.value = '';
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="!note" class="text-center py-16">
      <div class="mb-3 flex justify-center text-gray-300">
        <PhNotePencil size="3rem" weight="fill" />
      </div>
      <p class="text-gray-500 text-sm">笔记不存在或已被删除</p>
      <button @click="goBack" class="mt-4 text-xs text-primary hover:underline">返回</button>
    </div>

    <div v-else>
      <!-- Header -->
      <div class="flex items-center gap-3 mb-6 flex-wrap">
        <button @click="goBack" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
          <PhCaretLeft size="1.25rem" weight="fill" />
        </button>
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded-full font-medium bg-primary-light text-primary-dark">{{ typeLabels[note.type] }}</span>
          <span v-if="note.category" class="text-xs text-gray-400">{{ note.category }}</span>
        </div>
        <span class="text-xs text-gray-400 ml-auto">{{ dayjs(note.createdAt).format('YYYY-MM-DD HH:mm') }}</span>
        <button @click="openEditModal?.(note, true)" class="px-3 py-1 text-xs rounded-lg hover:bg-gray-100 text-gray-400 inline-flex items-center gap-1">
          <PhPencilSimple size="0.875rem" weight="fill" />
          <span>编辑</span>
        </button>
      </div>

      <!-- Summary -->
      <p v-if="note.summary" class="text-sm text-gray-500 italic mb-4">{{ note.summary }}</p>

      <!-- Tags -->
      <div v-if="note.tags?.length" class="flex flex-wrap gap-1.5 mb-4">
        <span v-for="tag in note.tags" :key="tag" class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">#{{ tag }}</span>
      </div>

      <!-- Content -->
      <div class="bg-white rounded-2xl shadow-sm p-6 md:p-8 note-content prose prose-sm max-w-none" v-html="rendered" />
    </div>
  </div>
</template>
