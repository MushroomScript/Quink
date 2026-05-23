<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useNotesStore } from '@/stores/notes';
import { useAuthStore } from '@/stores/auth';
import RichEditor from '@/components/RichEditor.vue';

// setup 顶层同步设主题（在 Vue 第一次 render 前），让窗口 show 时就是正确主题色，
// 避免暗色主题用户首次打开看到白色闪烁
document.documentElement.setAttribute('data-theme', localStorage.getItem('quink_theme') || 'blueberry');
// 同步用户字体大小(主窗口和 Capture 共享 localStorage),让 rem 单位的元素一致
const savedFontSize = localStorage.getItem('quink_font_size');
if (savedFontSize) document.documentElement.style.fontSize = savedFontSize + 'px';

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

// Vditor 加载完成时通知主进程，让它延迟到此刻才 show 窗口
function onEditorReady() {
  try { (window as any).quink?.notifyContentReady?.(); } catch {}
}

const notLoggedIn = ref(false);

onMounted(async () => {
  const user = await auth.fetchMe();
  if (!user) notLoggedIn.value = true;
  const theme = user?.preferences?.theme || 'blueberry';
  document.documentElement.setAttribute('data-theme', theme);
  document.addEventListener('keydown', onKeydown);

  // 每次窗口显示时同步主题 + 字体 + 聚焦编辑器
  try {
    (window as any).quink?.onWindowShown?.(() => {
      // 同步读 localStorage(不闪烁)
      const t = localStorage.getItem('quink_theme') || 'blueberry';
      document.documentElement.setAttribute('data-theme', t);
      const fs = localStorage.getItem('quink_font_size');
      if (fs) document.documentElement.style.fontSize = fs + 'px';
      setTimeout(() => {
        document.querySelector<HTMLElement>('.vditor-ir [contenteditable]')?.focus();
      }, 50);
    });
  } catch {}
  // 用户在主窗口改字体后,主进程主动通知,实时应用
  try {
    (window as any).quink?.onFontSizeChanged?.((size: number) => {
      document.documentElement.style.fontSize = size + 'px';
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
    <div v-else class="capture-editor-host flex-1 overflow-hidden bg-white rounded-xl shadow-2xl">
      <RichEditor ref="editorRef" @submit="onSubmit" @ready="onEditorReady" :show-ai="false" :show-fullscreen-btn="false" :max-height="80" :min-height="60" hint-text="Esc 关闭 | Ctrl+Enter 保存" placeholder="快速记录你的想法..." />
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
/* 快捷弹窗专用:底部栏更紧凑。
   用 rem 而非 px,让 padding/font-size 跟随用户字体大小按比例缩放,
   配合 main.ts 的 getCaptureHeight 公式 (窗口高度也按比例缩放) 实现整体等比例放大。
   基准是默认 fontSize 16: 2px = 0.125rem, 11px = 0.6875rem, 12px = 0.75rem 等。 */
.capture-drag .bg-gray-50.border-t {
  padding-top: 0.125rem !important;
  padding-bottom: 0.125rem !important;
}
.capture-drag .bg-gray-50.border-t .bg-primary {
  padding: 0.125rem 0.75rem !important;
  font-size: 0.6875rem !important;
}
.capture-drag .bg-gray-50.border-t .rounded-md {
  padding-top: 0.125rem !important;
  padding-bottom: 0.125rem !important;
  font-size: 0.6875rem !important;
}
/* 录音 overlay 同步压缩:停止按钮跟保存按钮一样大,计时秒数对齐 */
.capture-drag .voice-overlay {
  padding-top: 0.125rem !important;
  padding-bottom: 0.125rem !important;
}
.capture-drag .voice-stop-btn {
  padding: 0.125rem 0.75rem !important;
  font-size: 0.6875rem !important;
}
.capture-drag .voice-time {
  font-size: 0.6875rem !important;
}
.capture-drag .voice-live-text {
  font-size: 0.75rem !important;
}
/* Capture 场景下让 RichEditor 撑满窗口高度,字体变大窗口变高时编辑区跟着变大,
   而不是窗口底部留空白。RichEditor root 是渲染后的 div(直接 host 子) */
.capture-editor-host > div {
  height: 100%;
}
.capture-editor-host .vditor-wrapper {
  flex: 1 1 auto !important;
  min-height: 0 !important;
}
/* 解除 RichEditor 全局给 .vditor-content 设的 max-height 限制(Capture 传的 80px),
   否则 wrapper 被 flex 撑高后 content 仍锁在 80px,wrapper 内 toolbar+content 不够撑,
   底部留空白 */
.capture-editor-host .vditor-wrapper > .vditor-content {
  max-height: none !important;
}
/* Vditor 编辑区字体跟用户字体: 默认 16px 硬编码 → 1rem 跟 root font-size 缩放。
   内部 padding 8px 16px 也跟着缩放 */
.capture-drag .vditor-reset {
  font-size: 1rem !important;
  padding: 0.5rem 1rem !important;
}
/* Vditor toolbar 高度按字体缩放: --toolbar-height 默认 35px → 2.1875rem。
   配合内部 svg / button 也用 rem,toolbar 整体跟字体放大/缩小 */
.capture-drag .vditor {
  --toolbar-height: 2.1875rem !important;
}
.capture-drag .vditor-toolbar {
  padding: 0.125rem 0.375rem !important;
}
.capture-drag .vditor-wrapper .vditor-toolbar__item button,
.capture-drag .vditor-wrapper .vditor-toolbar__item > span,
.capture-drag .vditor-wrapper .vditor-toolbar__item [data-type="upload"] {
  height: 1.75rem !important;
  width: 1.75rem !important;
}
.capture-drag .vditor-wrapper .vditor-toolbar__item button svg,
.capture-drag .vditor-wrapper .vditor-toolbar__item [data-type="upload"] svg {
  height: 0.875rem !important;
  width: 0.875rem !important;
}
/* 底部按钮 row 的 .tbtn (标签/引用/录音/语音) class 在 style.css 硬编码 28×28px,
   capture-drag 范围内 override 成 rem,让 row 整体高度跟字体缩放 */
.capture-drag .tbtn {
  width: 1.75rem !important;
  height: 1.75rem !important;
}
/* 修双滚动条: .vditor-content 的 overflow-y: auto (RichEditor 全局 CSS) + .vditor-reset overflow: auto
   小字号时编辑区高度 < Vditor 内部 min-height → content 出滚动条; 内容多时 reset 又出一个。
   让 content 不出滚动条,只由 reset 负责。同时 min-height: 0 配合 flex 缩放 */
.capture-editor-host .vditor-wrapper > .vditor-content {
  min-height: 0 !important;
  overflow-y: hidden !important;
}
</style>
