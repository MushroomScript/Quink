<script setup lang="ts">
import { ref } from 'vue';
import { useNotesStore } from '@/stores/notes';
import { useToast } from '@/composables/useToast';
import RichEditor from './RichEditor.vue';

// 主界面 3 个 view (Inspiration/Notes/Todos) 的编辑器:固定走 view 对应的 type (defaultType),
// 不显示类型选择器 — 避免"在 /notes 编辑器选'灵感'保存"导致的卡片错落到非匹配列表的问题 (D1)。
// 跨类型快速记录走 Capture 快捷弹窗 (那里直接用 RichEditor 保留 type selector)。
const props = withDefaults(defineProps<{ defaultType?: string }>(), {
  defaultType: 'note',
});

const store = useNotesStore();
const toast = useToast();
const editorRef = ref<InstanceType<typeof RichEditor>>();
const submitting = ref(false);

async function onSubmit(data: { html: string; type: string; tags: string[]; visibility: 'private' | 'shared'; sharedGroupIds: string[] }) {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const note = await store.createNote(data.html, data.type, data.tags.length ? data.tags : undefined, data.visibility, data.sharedGroupIds);
    editorRef.value?.clearContent();
    toast.show('已保存');
    // AI 异步打标签/分类/摘要, 后台轮询单条直到 aiProcessed=true 后 mutate 进本地 (不触发 rebuild)
    store.pollNoteAiResult(note.id);
  } finally { submitting.value = false; }
}
</script>

<template>
  <div class="bg-white rounded-xl border border-gray-200 shadow-sm">
    <RichEditor ref="editorRef" @submit="onSubmit" :initial-type="defaultType" :show-type-selector="false" placeholder="写下你的想法..." />
  </div>
</template>
