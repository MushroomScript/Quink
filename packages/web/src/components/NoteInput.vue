<script setup lang="ts">
import { ref } from 'vue';
import { useNotesStore } from '@/stores/notes';
import RichEditor from './RichEditor.vue';

const props = withDefaults(defineProps<{ defaultType?: string }>(), { defaultType: 'auto' });

const store = useNotesStore();
const editorRef = ref<InstanceType<typeof RichEditor>>();
const submitting = ref(false);
const showToast = ref(false);

async function onSubmit(data: { html: string; type: string; tags: string[] }) {
  if (submitting.value) return;
  submitting.value = true;
  try {
    await store.createNote(data.html, data.type, data.tags.length ? data.tags : undefined);
    editorRef.value?.clearContent();
    showToast.value = true;
    setTimeout(() => (showToast.value = false), 2000);
    // AI 异步处理完后刷新，拉回标签和分类
    setTimeout(() => store.fetchNotes(), 4000);
  } finally { submitting.value = false; }
}
</script>

<template>
  <div class="bg-white rounded-xl border border-gray-200 shadow-sm">
    <RichEditor ref="editorRef" @submit="onSubmit" :initial-type="defaultType" :show-auto-type="defaultType === 'auto'" placeholder="写下你的想法..." />
  </div>

  <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0 translate-y-2" enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition duration-150 ease-in" leave-from-class="opacity-100 translate-y-0" leave-to-class="opacity-0 translate-y-2">
    <div v-if="showToast" class="fixed bottom-6 right-6 bg-green-600 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">已保存</div>
  </Transition>
</template>
