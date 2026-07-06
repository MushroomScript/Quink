<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useNotesStore } from '@/stores/notes';
import { useAuthStore } from '@/stores/auth';
import RichEditor from '@/components/RichEditor.vue';
import { PhXCircle } from '@phosphor-icons/vue';

// setup 顶层同步设主题（在 Vue 第一次 render 前），让窗口 show 时就是正确主题色，
// 避免暗色主题用户首次打开看到白色闪烁
document.documentElement.setAttribute('data-theme', localStorage.getItem('quink_theme') || 'blueberry');
// 显示比例 (zoom) 由 Electron 主进程 webContents.setZoomFactor 统一控制, renderer 不再操作 fontSize
// 老 data-font-size attribute 也不再设置 (zoom 模式下无需"对 12px 单独微调"这种字号相关的 CSS hack)

const store = useNotesStore();
const auth = useAuthStore();
const editorRef = ref<InstanceType<typeof RichEditor>>();
const submitting = ref(false);
const showToast = ref(false);
const toastMsg = ref('');

async function onSubmit(data: { html: string; type: string; tags: string[]; visibility: 'private' | 'shared'; sharedGroupIds: string[]; category: string | null }) {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const created = await store.createNote(data.html, data.type, data.tags.length ? data.tags : undefined, data.visibility, data.sharedGroupIds, data.category);
    editorRef.value?.clearContent();

    // 通知主窗口刷新 (带 id 让主窗口走单条轮询 patch 而不是全量 fetchNotes; 浏览器场景同 window 内 store listener 也收到)
    window.dispatchEvent(new CustomEvent('quink-note-created', { detail: { id: created.id } }));

    // 先关闭弹窗,再通知主进程显示 toast (id 用于 main 转发给主窗口)
    try { (window as any).quink?.hideWindow(); } catch {}
    try { (window as any).quink?.noteSaved?.(created.id); } catch {}
  } catch (err: any) {
    toastMsg.value = '保存失败: ' + err.message;
    showToast.value = true;
    setTimeout(() => (showToast.value = false), 3000);
  } finally { submitting.value = false; }
}

function closeWindow() {
  try { (window as any).quink?.hideWindow(); } catch {}
}

// Esc 关闭
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeWindow();
}

// Vditor 加载完成时通知主进程，让它延迟到此刻才 show 窗口
function onEditorReady() {
  try { (window as any).quink?.notifyContentReady?.(); } catch {}
}

const notLoggedIn = ref(false);

// Ctrl+滚轮 zoom 由 main 端 webContents.on('zoom-changed') 统一拦截 (renderer 的 wheel preventDefault
// 阻止不了 Chromium 内置 layout zoom, 会导致 zoom 变两次). 这里不再注册 wheel hook
onMounted(async () => {
  const user = await auth.fetchMe();
  if (!user) notLoggedIn.value = true;
  const theme = user?.preferences?.theme || 'blueberry';
  document.documentElement.setAttribute('data-theme', theme);
  document.addEventListener('keydown', onKeydown);

  // 每次窗口显示时同步主题 + 聚焦编辑器 (字号方案已切到 Electron zoom, 不需要前端 applyFontSize)
  try {
    (window as any).quink?.onWindowShown?.(() => {
      // 同步读 localStorage(不闪烁)
      const t = localStorage.getItem('quink_theme') || 'blueberry';
      document.documentElement.setAttribute('data-theme', t);
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
    <div v-if="notLoggedIn" class="relative flex-1 flex items-center justify-center bg-white rounded-lg shadow-2xl">
      <div class="text-center">
        <p class="text-gray-500 text-sm">请先在主窗口登录</p>
      </div>
      <button @click="closeWindow" class="capture-close-btn" style="-webkit-app-region: no-drag" title="关闭">
        <PhXCircle size="1.125rem" weight="fill" />
      </button>
    </div>

    <!-- Editor: rounded-lg=8px 匹配 Win11 BrowserWindow frameless OS 圆角, 避免角落露 BrowserWindow bg -->
    <div v-else class="capture-editor-host relative flex-1 overflow-hidden bg-white rounded-lg shadow-2xl">
      <RichEditor ref="editorRef" @submit="onSubmit" @ready="onEditorReady" :show-ai="false" :show-fullscreen-btn="false" :show-visibility-chip="false" :max-height="80" :min-height="60" placeholder="快速记录你的想法..." />
      <button @click="closeWindow" class="capture-close-btn" style="-webkit-app-region: no-drag" title="关闭">
        <PhXCircle size="1.125rem" weight="fill" />
      </button>
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
/* 右上角关闭按钮: 跟 vditor toolbar 内表情按钮同尺寸 (1.75rem 外框 + 0.875rem svg).
   必须放在 RichEditor 之后 (DOM 顺序): 否则 vditor toolbar 后绘制盖上, OS 把按钮位置当 drag 区 → click 派不进 DOM. */
.capture-close-btn {
  position: absolute;
  top: 0;
  right: 0.25rem;
  z-index: var(--z-sidebar);
  width: 2.1875rem;
  height: 2.1875rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #9ca3af;
  transition: color 0.15s;
}
.capture-close-btn:hover {
  color: #ef4444;
}
[data-theme="dark"] .capture-close-btn {
  color: rgba(255,255,255,0.4);
}
[data-theme="dark"] .capture-close-btn:hover {
  color: #f87171;
}
.capture-drag .vditor-toolbar {
  -webkit-app-region: drag;
}
.capture-drag .vditor-toolbar__item {
  -webkit-app-region: no-drag;
}
/* 快捷弹窗专用:底部栏。
   用 rem 而非 px,让 padding/font-size 跟随用户字体大小按比例缩放,
   配合 main.ts 的 getCaptureSize 公式 (窗口宽高也按比例缩放) 实现整体等比例放大。
   基准默认 fontSize 16: 4px = 0.25rem, 13px = 0.8125rem, 14px = 0.875rem 等。 */
.capture-drag .bg-gray-50.border-t {
  padding-top: 0.25rem !important;
  padding-bottom: 0.25rem !important;
}
.capture-drag .bg-gray-50.border-t .bg-primary {
  padding: 0.25rem 0.875rem !important;
  font-size: 0.8125rem !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  line-height: 1 !important;
  /* 跟 type 按钮(灵感/笔记/待办)同高: type 是 padding 0.25rem*2 + line-height 1rem = 1.5rem,
     保存按钮 line-height: 1 让 line-box = font-size 0.8125rem 小一些,
     用 min-height 1.5rem 拉高对齐,flex 仍然让字符居中 */
  min-height: 1.5rem !important;
}
.capture-drag .bg-gray-50.border-t .rounded-md {
  padding-top: 0.25rem !important;
  padding-bottom: 0.25rem !important;
  font-size: 0.8125rem !important;
}
/* 录音 overlay 同步压缩:停止按钮跟保存按钮一样大,计时秒数对齐 */
.capture-drag .voice-overlay {
  padding-top: 0.25rem !important;
  padding-bottom: 0.25rem !important;
}
.capture-drag .voice-stop-btn {
  padding: 0.25rem 0.875rem !important;
  font-size: 0.8125rem !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  line-height: 1 !important;
  /* 同保存按钮:跟 type 按钮同高 */
  min-height: 1.5rem !important;
}
/* 12px / 16px 字号下中文字形视觉重心偏下明显(其他字号下抗锯齿能掩盖),
   单独加上下不对称 padding 让字符上移 1px */
[data-font-size="12"] .capture-drag .bg-gray-50.border-t .bg-primary,
[data-font-size="12"] .capture-drag .voice-stop-btn,
[data-font-size="16"] .capture-drag .bg-gray-50.border-t .bg-primary,
[data-font-size="16"] .capture-drag .voice-stop-btn {
  padding-top: calc(0.25rem - 1px) !important;
  padding-bottom: calc(0.25rem + 1px) !important;
}
.capture-drag .voice-time {
  font-size: 0.8125rem !important;
}
.capture-drag .voice-live-text {
  font-size: 0.875rem !important;
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
.capture-drag .vditor-wrapper .vditor-toolbar__item > button,
.capture-drag .vditor-wrapper .vditor-toolbar__item > span,
.capture-drag .vditor-wrapper .vditor-toolbar__item > [data-type="upload"] {
  height: 1.75rem !important;
  width: 1.75rem !important;
}
.capture-drag .vditor-wrapper .vditor-toolbar__item > button svg,
.capture-drag .vditor-wrapper .vditor-toolbar__item > [data-type="upload"] svg {
  height: 0.875rem !important;
  width: 0.875rem !important;
}
/* 全局 toolbar 按钮有固定 transform: translateY(3px) 让按钮视觉下移(主页 toolbar 35px 估算的)。
   capture 中 toolbar/button 用 rem 缩放,不同字号下 transform 跟按钮大小比例失调 →
   小字号靠下、大字号靠上。直接把 toolbar 改成 flex 居中容器,按钮自然垂直居中,
   取消 transform,所有字号下严格对齐。Vditor 默认 toolbar__item 是 float: left,
   也得 unset 让 flex 子元素正常排列 */
.capture-drag .vditor-wrapper .vditor-toolbar {
  display: flex !important;
  align-items: center !important;
}
.capture-drag .vditor-wrapper .vditor-toolbar__item {
  float: none !important;
}
.capture-drag .vditor-wrapper .vditor-toolbar__item > button,
.capture-drag .vditor-wrapper .vditor-toolbar__item > span,
.capture-drag .vditor-wrapper .vditor-toolbar__item > [data-type="upload"] {
  /* flex 居中后再固定下移 1px 微调视觉重心 */
  transform: translateY(1px) !important;
}
/* 底部按钮 row 的 .tbtn (标签/引用/录音/语音) class 在 style.css 硬编码 28×28px,
   capture-drag 范围内 override 成 rem,让 row 整体高度跟字体缩放。
   2.125rem (= 34px @ fontSize 16) 跟其他按钮高度协调 (padding 0.25 上下 + font 0.8125 = ~21px + 4 + border 等) */
.capture-drag .tbtn {
  width: 2.125rem !important;
  height: 2.125rem !important;
}
/* 修双滚动条: .vditor-content 的 overflow-y: auto (RichEditor 全局 CSS) + .vditor-reset overflow: auto
   小字号时编辑区高度 < Vditor 内部 min-height → content 出滚动条; 内容多时 reset 又出一个。
   让 content 不出滚动条,只由 reset 负责。同时 min-height: 0 配合 flex 缩放 */
.capture-editor-host .vditor-wrapper > .vditor-content {
  min-height: 0 !important;
  overflow-y: hidden !important;
}
</style>
