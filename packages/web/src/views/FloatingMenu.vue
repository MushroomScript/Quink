<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { api, isLoggedIn } from '@/api';

const auth = useAuthStore();
const text = ref('');
const processing = ref(false);
const result = ref('');
const saved = ref(false);

// Read text from URL query param (Electron passes it)
onMounted(async () => {
  await auth.fetchMe();
  const params = new URLSearchParams(window.location.search);
  text.value = params.get('text') || '';
});

async function addAsInspiration() {
  if (!text.value.trim() || !isLoggedIn()) return;
  processing.value = true;
  try {
    await api.createNote({ content: text.value, type: 'note' });
    saved.value = true;
    setTimeout(() => hideWindow(), 800);
  } catch {}
  processing.value = false;
}

async function addAsTodo() {
  if (!text.value.trim() || !isLoggedIn()) return;
  processing.value = true;
  try {
    await api.createNote({ content: text.value, type: 'todo' });
    saved.value = true;
    setTimeout(() => hideWindow(), 800);
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
    setTimeout(() => hideWindow(), 800);
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

function hideWindow() {
  try { (window as any).quink?.hideWindow(); } catch {}
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') hideWindow();
}
</script>

<template>
  <div class="h-full flex items-center justify-center select-none" @keydown="onKeydown" tabindex="0"
    style="background: rgb(var(--c-sidebar)); border-radius: 12px;">

    <!-- Processing -->
    <div v-if="processing" class="px-3">
      <span class="text-xs" style="color: var(--sb-dim)">处理中...</span>
    </div>

    <!-- Saved -->
    <div v-else-if="saved" class="px-3">
      <span class="text-sm" style="color: rgb(var(--c-accent))">✓</span>
    </div>

    <!-- AI result: show save/back -->
    <div v-else-if="result" class="flex items-center gap-1 px-2">
      <button @click="saveOrganized" class="float-btn" title="保存结果">💾</button>
      <button @click="result = ''" class="float-btn" title="返回">↩</button>
    </div>

    <!-- Icons -->
    <div v-else class="flex items-center gap-1 px-2">
      <button @click="addAsInspiration" class="float-btn" title="添加到灵感">💡</button>
      <button @click="addAsTodo" class="float-btn" title="添加到待办">✅</button>
      <button @click="aiOrganize" class="float-btn" title="AI 整理后添加">🤖</button>
      <button @click="translate" class="float-btn" title="翻译成中文">🌐</button>
    </div>
  </div>
</template>

<style scoped>
.float-btn {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px; font-size: 16px;
  border: none; cursor: pointer;
  background: var(--sb-hover);
  transition: all 0.15s;
}
.float-btn:hover { transform: scale(1.15); background: var(--sb-active-bg); }
.float-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
.line-clamp-2 {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
</style>
