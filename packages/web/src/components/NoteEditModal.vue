<script setup lang="ts">
import { ref } from 'vue';
import { useNotesStore } from '@/stores/notes';
import RichEditor from './RichEditor.vue';
import type { Note } from '@/api';

const props = defineProps<{ note: Note }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useNotesStore();
const saving = ref(false);

async function onSubmit(data: { html: string; type: string; tags: string[] }) {
  if (saving.value) return;
  saving.value = true;
  try {
    await store.updateNote(props.note.id, {
      content: data.html,
      type: data.type as any,
      tags: data.tags,
    });
    emit('close');
  } finally { saving.value = false; }
}

function onBackdropClick() { emit('close'); }

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); emit('close'); }
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[100] flex items-center justify-center" @keydown="onKeydown">
      <!-- Backdrop: 毛玻璃 -->
      <div class="absolute inset-0 bg-black/40 backdrop-blur-md" @click="onBackdropClick" />

      <!-- Modal -->
      <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col overflow-hidden ring-1 ring-black/5">
        <!-- Header -->
        <div class="flex items-center justify-between px-5 py-3 bg-gray-50/80">
          <span class="text-xs font-medium text-gray-500">编辑笔记</span>
          <div class="flex items-center gap-3">
            <span class="text-[11px] text-gray-400 hidden sm:inline">
              <kbd class="px-1.5 py-0.5 bg-gray-200/60 rounded text-[10px]">Esc</kbd> 关闭
              <kbd class="px-1.5 py-0.5 bg-gray-200/60 rounded text-[10px] ml-1">Ctrl+Enter</kbd> 保存
            </span>
            <button @click="emit('close')" class="p-1 rounded-lg hover:bg-gray-200/60 text-gray-400 transition-colors">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <!-- Shared RichEditor -->
        <div class="flex-1 flex flex-col overflow-hidden">
          <RichEditor
            :initial-content="note.content"
            :initial-type="note.type"
            :initial-tags="note.tags || []"
            :show-auto-type="false"
            submit-label="保存"
            :z-index="110"
            @submit="onSubmit"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>
