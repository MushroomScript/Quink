<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { api, isLoggedIn } from '@/api';
import {
  PhCheck,
  PhFloppyDisk,
  PhCaretLeft,
  PhLightbulb,
  PhNotePencil,
  PhSparkle,
  PhTranslate,
  PhCopy,
} from '@phosphor-icons/vue';

const auth = useAuthStore();
const text = ref('');
const processing = ref(false);
const result = ref('');
const saved = ref(false);

onMounted(async () => {
  // 注入透明样式,压过全局 body/--c-body 背景
  const style = document.createElement('style');
  style.textContent = 'html,body,#app{background:transparent !important;overflow:hidden !important;}';
  document.head.appendChild(style);
  await auth.fetchMe();
  // 跟主窗口一样,根据用户偏好设置主题
  const theme = auth.user?.preferences?.theme || 'blueberry';
  document.documentElement.setAttribute('data-theme', theme);
  const params = new URLSearchParams(window.location.search);
  text.value = params.get('text') || '';
});

async function addAsInspiration() {
  if (!text.value.trim() || !isLoggedIn()) return;
  processing.value = true;
  try {
    // PR #8 命名重整: 灵感字段值 'quink' (旧 'note')
    await api.createNote({ content: text.value, type: 'quink' });
    saved.value = true;
    setTimeout(() => hideWindow(), 600);
  } catch {}
  processing.value = false;
}

async function addAsNote() {
  if (!text.value.trim() || !isLoggedIn()) return;
  processing.value = true;
  try {
    // PR #8 命名重整: 笔记字段值 'note' (旧 'snippet'). 顺手修历史 bug: 旧代码这里 type 写 'note' 实际加的是灵感, 跟 addAsInspiration 重复
    await api.createNote({ content: text.value, type: 'note', category: '笔记' });
    saved.value = true;
    setTimeout(() => hideWindow(), 600);
  } catch {}
  processing.value = false;
}

async function aiOrganize() {
  if (!text.value.trim() || !isLoggedIn()) return;
  processing.value = true;
  result.value = '';
  try {
    const res = await api.aiProcess('polish', text.value);
    result.value = res.data.result;
  } catch (err: any) {
    result.value = '处理失败: ' + err.message;
  }
  processing.value = false;
}

async function saveOrganized() {
  if (!result.value.trim()) return;
  processing.value = true;
  try {
    // PR #8 命名重整: AI 整理后保存默认为灵感 'quink' (旧 'note')
    await api.createNote({ content: result.value, type: 'quink' });
    saved.value = true;
    setTimeout(() => hideWindow(), 600);
  } catch {}
  processing.value = false;
}

async function translate() {
  if (!text.value.trim() || !isLoggedIn()) return;
  processing.value = true;
  result.value = '';
  try {
    const res = await api.aiProcess('polish', text.value,
      '请将以下内容翻译成中文，只返回翻译结果：\n\n{content}');
    result.value = res.data.result;
  } catch (err: any) {
    result.value = '翻译失败: ' + err.message;
  }
  processing.value = false;
}

async function copyText() {
  if (!text.value.trim()) return;
  try {
    await navigator.clipboard.writeText(text.value);
  } catch {}
  saved.value = true;
  setTimeout(() => hideWindow(), 500);
}

function hideWindow() {
  try { (window as any).quink?.hideWindow(); } catch {}
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') hideWindow();
}
</script>

<template>
  <div class="float-bar" @keydown="onKeydown" tabindex="0">

    <!-- Processing -->
    <div v-if="processing" class="float-state">
      <span class="spinner" />
    </div>

    <!-- Saved -->
    <div v-else-if="saved" class="float-state saved">
      <PhCheck size="0.8125rem" weight="fill" />
    </div>

    <!-- AI result -->
    <div v-else-if="result" class="float-group">
      <button @click="saveOrganized" class="float-btn" title="保存结果">
        <PhFloppyDisk size="0.8125rem" weight="fill" />
        <span>保存</span>
      </button>
      <div class="float-divider" />
      <button @click="result = ''" class="float-btn" title="返回">
        <PhCaretLeft size="0.8125rem" weight="fill" />
        <span>返回</span>
      </button>
    </div>

    <!-- Icons + text -->
    <div v-else class="float-group">
      <button @click="addAsInspiration" class="float-btn" title="灵感">
        <PhLightbulb size="0.8125rem" weight="fill" />
        <span>灵感</span>
      </button>
      <div class="float-divider" />
      <button @click="addAsNote" class="float-btn" title="笔记">
        <PhNotePencil size="0.8125rem" weight="fill" />
        <span>笔记</span>
      </button>
      <div class="float-divider" />
      <button @click="aiOrganize" class="float-btn" title="AI 整理">
        <PhSparkle size="0.8125rem" weight="fill" />
        <span>AI整理</span>
      </button>
      <div class="float-divider" />
      <button @click="translate" class="float-btn" title="翻译">
        <PhTranslate size="0.8125rem" weight="fill" />
        <span>翻译</span>
      </button>
      <div class="float-divider" />
      <button @click="copyText" class="float-btn" title="复制">
        <PhCopy size="0.8125rem" weight="fill" />
        <span>复制</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.float-bar {
  height: 100%;
  display: flex;
  align-items: stretch;
  background: rgb(var(--c-accent-light));
  overflow: hidden;
  outline: none;
  user-select: none;
  -webkit-app-region: drag;
}
.float-btn:focus,
.float-btn:focus-visible {
  outline: none;
}

.float-group {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  width: 100%;
  height: 100%;
}

.float-btn {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--sb-text);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0;
  white-space: nowrap;
  cursor: var(--cur-pointer), pointer;
  transition: background 0.12s ease, color 0.12s ease;
  -webkit-app-region: no-drag;
}
.float-btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: rgb(var(--c-accent-dark));
}
.float-btn:active {
  background: rgba(0, 0, 0, 0.1);
}
.float-btn:disabled { opacity: 0.4; cursor: var(--cur-not-allowed), not-allowed; }
.float-btn svg { flex-shrink: 0; }

.float-divider {
  width: 1px;
  margin: 6px 0;
  background: rgba(0, 0, 0, 0.08);
  flex-shrink: 0;
}

.float-state {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  color: var(--sb-text);
  font-size: 12px;
}
.float-state.saved { color: rgb(var(--c-accent-dark)); }

.spinner {
  width: 12px; height: 12px;
  border: 2px solid rgba(0, 0, 0, 0.15);
  border-top-color: rgb(var(--c-accent-dark));
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
