<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { api, isLoggedIn } from '@/api';

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
    await api.createNote({ content: text.value, type: 'note' });
    saved.value = true;
    setTimeout(() => hideWindow(), 600);
  } catch {}
  processing.value = false;
}

async function addAsNote() {
  if (!text.value.trim() || !isLoggedIn()) return;
  processing.value = true;
  try {
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
    await api.createNote({ content: result.value, type: 'note' });
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
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </div>

    <!-- AI result -->
    <div v-else-if="result" class="float-group">
      <button @click="saveOrganized" class="float-btn" title="保存结果">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
          <polyline points="17 21 17 13 7 13 7 21"></polyline>
          <polyline points="7 3 7 8 15 8"></polyline>
        </svg>
        <span>保存</span>
      </button>
      <div class="float-divider" />
      <button @click="result = ''" class="float-btn" title="返回">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
        <span>返回</span>
      </button>
    </div>

    <!-- Icons + text -->
    <div v-else class="float-group">
      <button @click="addAsInspiration" class="float-btn" title="灵感">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"></path>
        </svg>
        <span>灵感</span>
      </button>
      <div class="float-divider" />
      <button @click="addAsNote" class="float-btn" title="笔记">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="8" y1="13" x2="16" y2="13"></line>
          <line x1="8" y1="17" x2="13" y2="17"></line>
        </svg>
        <span>笔记</span>
      </button>
      <div class="float-divider" />
      <button @click="aiOrganize" class="float-btn" title="AI 整理">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
        <span>AI整理</span>
      </button>
      <div class="float-divider" />
      <button @click="translate" class="float-btn" title="翻译">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"></path>
        </svg>
        <span>翻译</span>
      </button>
      <div class="float-divider" />
      <button @click="copyText" class="float-btn" title="复制">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
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
  cursor: pointer;
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
.float-btn:disabled { opacity: 0.4; cursor: not-allowed; }
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
