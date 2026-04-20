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

    // 通知主窗口刷新
    window.dispatchEvent(new CustomEvent('quink-note-created'));

    // 先关闭弹窗,再通知主进程显示 toast
    try { (window as any).quink?.hideWindow(); } catch {}
    try { (window as any).quink?.noteSaved?.(); } catch {}
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

  // 每次窗口显示时聚焦编辑器
  try {
    (window as any).quink?.onWindowShown?.(() => {
      setTimeout(() => {
        document.querySelector<HTMLElement>('.vditor-ir [contenteditable]')?.focus();
      }, 50);
    });
  } catch {}
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="h-full flex flex-col bg-transparent tooltip-below capture-drag">
    <!-- Not logged in -->
    <div v-if="notLoggedIn" class="flex-1 flex items-center justify-center bg-white rounded-xl shadow-2xl">
      <div class="text-center">
        <p class="text-gray-500 text-sm">请先在主窗口登录</p>
        <p class="text-gray-400 text-xs mt-1">Esc 关闭</p>
      </div>
    </div>

    <!-- Editor -->
    <div v-else class="flex-1 overflow-hidden bg-white rounded-xl shadow-2xl">
      <RichEditor ref="editorRef" @submit="onSubmit" :show-ai="false" :show-fullscreen-btn="false" :max-height="80" :min-height="60" hint-text="Esc 关闭 | Ctrl+Enter 保存" placeholder="快速记录你的想法..." />
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

<style>
.capture-drag .vditor-toolbar {
  -webkit-app-region: drag;
}
.capture-drag .vditor-toolbar__item {
  -webkit-app-region: no-drag;
}
/* 快捷弹窗专用:底部栏更紧凑 */
.capture-drag .bg-gray-50.border-t {
  padding-top: 2px !important;
  padding-bottom: 2px !important;
}
.capture-drag .bg-gray-50.border-t .bg-primary {
  padding: 2px 12px !important;
  font-size: 11px !important;
}
.capture-drag .bg-gray-50.border-t .rounded-md {
  padding-top: 2px !important;
  padding-bottom: 2px !important;
  font-size: 11px !important;
}
</style>
