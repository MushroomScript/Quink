<script setup lang="ts">
import { ref } from 'vue';
import { useNotesStore } from '@/stores/notes';
import { useToast } from '@/composables/useToast';
import RichEditor from './RichEditor.vue';

const props = withDefaults(defineProps<{ defaultType?: string; showTypeSelector?: boolean }>(), {
  defaultType: 'note',
  showTypeSelector: true,
});

const store = useNotesStore();
const toast = useToast();
const editorRef = ref<InstanceType<typeof RichEditor>>();
const submitting = ref(false);

async function onSubmit(data: { html: string; type: string; tags: string[] }) {
  if (submitting.value) return;
  submitting.value = true;
  try {
    await store.createNote(data.html, data.type, data.tags.length ? data.tags : undefined);
    editorRef.value?.clearContent();
    toast.show('已保存');
    // AI 异步处理完后刷新,拉回标签和分类
    setTimeout(() => store.fetchNotes(), 4000);
  } finally { submitting.value = false; }
}
</script>

<template>
  <div class="bg-white rounded-xl border border-gray-200 shadow-sm">
    <RichEditor ref="editorRef" @submit="onSubmit" :initial-type="defaultType" :show-type-selector="showTypeSelector" placeholder="写下你的想法..." />
  </div>
</template>
