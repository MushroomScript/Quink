<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { api, isLoggedIn } from '@/api';
import Vditor from 'vditor';

const auth = useAuthStore();
const query = ref('');
const messages = ref<{ role: 'user' | 'ai'; content: string; html?: string }[]>([]);
const loading = ref(false);
const notLoggedIn = ref(false);
const messagesEl = ref<HTMLDivElement>();
const inputEl = ref<HTMLInputElement>();

async function sendMessage() {
  const text = query.value.trim();
  if (!text || loading.value) return;

  messages.value.push({ role: 'user', content: text });
  query.value = '';
  loading.value = true;
  scrollToBottom();

  try {
    const res = await api.aiChat(text);
    const html = await Vditor.md2html(res.data.result);
    messages.value.push({ role: 'ai', content: res.data.result, html });
  } catch (err: any) {
    messages.value.push({ role: 'ai', content: err.message || 'AI 处理失败' });
  } finally {
    loading.value = false;
    scrollToBottom();
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  });
}

function handleInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    try { (window as any).quink?.hideWindow(); } catch {}
  }
}

onMounted(async () => {
  const user = await auth.fetchMe();
  if (!user) notLoggedIn.value = true;
  const theme = user?.preferences?.theme || 'blueberry';
  document.documentElement.setAttribute('data-theme', theme);
  document.addEventListener('keydown', onGlobalKeydown);
  setTimeout(() => inputEl.value?.focus(), 500);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown);
});
</script>

<template>
  <div class="h-full flex flex-col select-none">
    <!-- Title bar -->
    <div class="flex items-center justify-between px-4 py-2 shrink-0" style="-webkit-app-region: drag; background: rgb(var(--c-sidebar))">
      <span class="text-xs font-semibold" style="color: var(--sb-text)">🤖 AI 对话</span>
      <span class="text-[10px]" style="color: var(--sb-dim); -webkit-app-region: no-drag">Esc 关闭</span>
    </div>

    <div v-if="notLoggedIn" class="flex-1 flex items-center justify-center bg-white">
      <p class="text-gray-500 text-sm">请先在主窗口登录</p>
    </div>

    <template v-else>
      <!-- Messages -->
      <div ref="messagesEl" class="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-white">
        <div v-if="messages.length === 0" class="text-center py-8">
          <div class="text-3xl mb-2">🤖</div>
          <p class="text-gray-400 text-xs">问我任何关于你笔记的问题</p>
        </div>

        <div v-for="(msg, i) in messages" :key="i" class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
          <div class="max-w-[85%] px-3 py-2 rounded-2xl text-sm"
            :class="msg.role === 'user' ? 'bg-primary text-white rounded-br-md' : 'bg-gray-100 text-gray-700 rounded-bl-md'">
            <div v-if="msg.html" class="note-content prose prose-sm max-w-none" v-html="msg.html" />
            <template v-else>{{ msg.content }}</template>
          </div>
        </div>

        <div v-if="loading" class="flex justify-start">
          <div class="bg-gray-100 text-gray-400 px-3 py-2 rounded-2xl rounded-bl-md text-sm">思考中...</div>
        </div>
      </div>

      <!-- Input -->
      <div class="px-3 py-2 border-t border-gray-100 bg-white shrink-0">
        <div class="flex gap-2">
          <input ref="inputEl" v-model="query" @keydown="handleInputKeydown" placeholder="问点什么..."
            class="flex-1 px-3 py-2 bg-gray-50 border-0 rounded-full text-sm outline-none focus:bg-white focus:ring-2 focus:ring-primary/30" />
          <button @click="sendMessage" :disabled="!query.trim() || loading"
            class="px-4 py-2 bg-primary text-white text-xs font-medium rounded-full hover:bg-primary-dark disabled:opacity-40 shrink-0">
            发送
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
