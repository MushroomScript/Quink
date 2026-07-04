<script setup lang="ts">
import { ref, withDefaults } from 'vue';
import { useNotesStore } from '@/stores/notes';
import VisibilityChip from './VisibilityChip.vue';

// 跟 NoteInput 对齐: 主界面编辑器 type 强制走 view 对应的 defaultType,
// 避免在 /notes / /todos 编辑器写的内容默认变成灵感 (D1 错配)。
const props = withDefaults(defineProps<{ defaultType?: string }>(), {
  defaultType: 'quink',
});

const store = useNotesStore();
const content = ref('');
const submitting = ref(false);
const showToast = ref(false);
// 群组共享: chip 控制可见性
const visibilityModel = ref<{ visibility: 'private' | 'shared'; sharedGroupIds: string[] }>({
  visibility: 'private',
  sharedGroupIds: [],
});

async function submit() {
  const text = content.value.trim();
  if (!text || submitting.value) return;
  submitting.value = true;
  try {
    const note = await store.createNote(text, props.defaultType, undefined, visibilityModel.value.visibility, visibilityModel.value.sharedGroupIds);
    content.value = '';
    // 发布后 visibility 重置成 private (跟 RichEditor clearContent 同款), 防上次选的群残留下一条
    visibilityModel.value = { visibility: 'private', sharedGroupIds: [] };
    showToast.value = true;
    setTimeout(() => (showToast.value = false), 1500);
    // AI 异步打标签/分类/摘要, 后台轮询单条直到 aiProcessed=true 后 mutate 进本地 (不触发 rebuild)
    store.pollNoteAiResult(note.id);
  } finally { submitting.value = false; }
}
</script>

<template>
  <div class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
    <textarea
      v-model="content"
      placeholder="随手记一个想法..."
      rows="4"
      class="w-full px-4 py-3 text-sm outline-none resize-none text-gray-800 placeholder-gray-400"
      @keydown.ctrl.enter="submit"
    />
    <div class="flex items-center justify-end gap-2 px-4 py-2 bg-gray-50 border-t border-gray-100">
      <VisibilityChip v-model="visibilityModel" compact />
      <button @click="submit" :disabled="!content.trim() || submitting"
        class="px-4 py-1.5 text-white text-xs font-medium rounded-lg disabled:opacity-40 transition-colors"
        style="background: rgb(var(--c-accent))">
        {{ submitting ? '...' : '保存' }}
      </button>
    </div>
  </div>

  <Transition enter-active-class="transition duration-200" enter-from-class="opacity-0 translate-y-2"
    leave-active-class="transition duration-150" leave-to-class="opacity-0 translate-y-2">
    <div v-if="showToast" class="fixed bottom-20 left-1/2 -translate-x-1/2 bg-green-600 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-[var(--z-sidebar)]">已保存</div>
  </Transition>
</template>
