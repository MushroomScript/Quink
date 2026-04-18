<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useNotesStore } from '@/stores/notes';
import { useAuthStore } from '@/stores/auth';
import RichEditor from '@/components/RichEditor.vue';

const store = useNotesStore();
const auth = useAuthStore();
const editorRef = ref<InstanceType<typeof RichEditor>>();
const submitting = ref(false);
const showToast = ref(false);
const toastMsg = ref('');

async function onSubmit(data: { html: string; type: string; tags: string[] }) {
  if (submitting.value) return;
  submitting.value = true;
  try {
    await store.createNote(data.html, data.type, data.tags.length ? data.tags : undefined);
    editorRef.value?.clearContent();
    toastMsg.value = '已保存';
    showToast.value = true;
    setTimeout(() => (showToast.value = false), 1500);

    // 通知主窗口刷新
    window.dispatchEvent(new CustomEvent('quink-note-created'));

    // 自动隐藏弹窗
    setTimeout(() => {
      try { (window as any).quink?.hideWindow(); } catch {}
    }, 800);
  } catch (err: any) {
    toastMsg.value = '保存失败: ' + err.message;
    showToast.value = true;
    setTimeout(() => (showToast.value = false), 3000);
  } finally { submitting.value = false; }
}

// Esc 关闭
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    try { (window as any).quink?.hideWindow(); } catch {}
  }
}

const notLoggedIn = ref(false);

onMounted(async () => {
  const user = await auth.fetchMe();
  if (!user) notLoggedIn.value = true;
  const theme = user?.preferences?.theme || 'blueberry';
  document.documentElement.setAttribute('data-theme', theme);
  document.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="h-full flex flex-col bg-transparent">
    <!-- Draggable title bar (follows theme) -->
    <div class="flex items-center justify-between px-4 py-2 rounded-t-xl" style="-webkit-app-region: drag; background: rgb(var(--c-sidebar))">
      <span class="text-xs font-semibold" style="color: var(--sb-text)">Quink</span>
      <span class="text-[10px]" style="color: var(--sb-dim); -webkit-app-region: no-drag">Esc 关闭 | Ctrl+Enter 保存</span>
    </div>

    <!-- Not logged in -->
    <div v-if="notLoggedIn" class="flex-1 flex items-center justify-center bg-white rounded-b-xl shadow-2xl">
      <div class="text-center">
        <p class="text-gray-500 text-sm">请先在主窗口登录</p>
        <p class="text-gray-400 text-xs mt-1">Esc 关闭</p>
      </div>
    </div>

    <!-- Editor -->
    <div v-else class="flex-1 overflow-hidden bg-white rounded-b-xl shadow-2xl flex flex-col">
      <RichEditor ref="editorRef" @submit="onSubmit" :show-auto-type="true" :show-ai="false" :min-height="150" placeholder="快速记录你的想法..." class="flex-1 flex flex-col" />
    </div>

    <!-- Toast -->
    <Transition enter-active-class="transition duration-200" enter-from-class="opacity-0 translate-y-2"
      leave-active-class="transition duration-150" leave-to-class="opacity-0 translate-y-2">
      <div v-if="showToast" class="fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm text-white shadow-lg"
        :class="toastMsg.startsWith('保存失败') ? 'bg-red-500' : 'bg-green-600'">
        {{ toastMsg }}
      </div>
    </Transition>
  </div>
</template>
