<script setup lang="ts">
import { ref } from 'vue';
import { useNotesStore } from '@/stores/notes';
import RichEditor from './RichEditor.vue';
import type { Note } from '@/api';
import { PhXCircle } from '@phosphor-icons/vue';

const props = defineProps<{ note: Note; initialFullscreen?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useNotesStore();
const saving = ref(false);
const editorRef = ref<InstanceType<typeof RichEditor>>();
const showConfirm = ref(false);

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

function tryClose() {
  if (editorRef.value?.isDirty) {
    showConfirm.value = true;
  } else {
    emit('close');
  }
}

function confirmDiscard() {
  showConfirm.value = false;
  emit('close');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (showConfirm.value) {
      showConfirm.value = false;
    } else {
      tryClose();
    }
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[100] flex items-center justify-center" @keydown="onKeydown">
      <!-- Backdrop: 毛玻璃 -->
      <div class="absolute inset-0 bg-black/40 backdrop-blur-md" @click="tryClose" />

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
            <button @click="tryClose" class="p-1 rounded-lg hover:bg-gray-200/60 text-gray-400 transition-colors">
              <PhXCircle size="1rem" weight="fill" />
            </button>
          </div>
        </div>

        <!-- Shared RichEditor -->
        <div class="overflow-hidden">
          <RichEditor
            ref="editorRef"
            :initial-content="note.content"
            :initial-type="note.type"
            :initial-tags="note.tags || []"
            :initial-fullscreen="initialFullscreen"
            :max-height="450"
            submit-label="保存"
            :z-index="110"
            @submit="onSubmit"
          />
        </div>
      </div>

      <!-- 未保存确认弹窗 -->
      <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0 scale-95"
        leave-active-class="transition duration-100 ease-in" leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
        <div v-if="showConfirm" class="absolute inset-0 z-10 flex items-center justify-center">
          <div class="absolute inset-0 bg-black/20" @click="showConfirm = false" />
          <div class="relative bg-white rounded-xl shadow-xl p-6 w-80 text-center">
            <p class="text-sm text-gray-700 mb-1">内容尚未保存</p>
            <p class="text-xs text-gray-400 mb-5">关闭后未保存的修改将丢失</p>
            <div class="flex gap-3 justify-center">
              <button @click="showConfirm = false"
                class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
                继续编辑
              </button>
              <button @click="confirmDiscard"
                class="px-4 py-1.5 text-xs rounded-lg text-white transition-colors"
                style="background: rgb(var(--c-accent-dark))">
                放弃修改
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </Teleport>
</template>
