<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { api, isLoggedIn } from '@/api';
import Vditor from 'vditor';
import { PhSparkle, PhStop, PhPaperPlaneTilt } from '@phosphor-icons/vue';

const auth = useAuthStore();
const query = ref('');
const messages = ref<{ id: string; role: 'user' | 'assistant'; content: string; html?: string }[]>([]);
const loading = ref(false);
const streamingContent = ref('');
const notLoggedIn = ref(false);
const messagesEl = ref<HTMLDivElement>();
const inputEl = ref<HTMLInputElement>();
const convId = ref('');

function parseThinking(text: string): { thinking: string; answer: string } {
  const m = text.match(/<think>([\s\S]*?)(<\/think>|$)/);
  if (!m) return { thinking: '', answer: text };
  return { thinking: m[1].trim(), answer: text.includes('</think>') ? text.replace(/<think>[\s\S]*?<\/think>/, '').trim() : '' };
}

function stripOuterCodeFence(text: string): string {
  const m = text.trim().match(/^```(?:markdown|md|text)?\n([\s\S]*?)\n```$/);
  return m ? m[1] : text;
}

async function ensureConversation() {
  if (!convId.value) {
    const res = await api.createConversation();
    convId.value = res.data.id;
  }
}

async function sendMessage() {
  const text = query.value.trim();
  if (!text || loading.value) return;
  await ensureConversation();

  messages.value.push({ id: 'u-' + Date.now(), role: 'user', content: text });
  query.value = '';
  loading.value = true;
  streamingContent.value = '';
  scrollToBottom();

  try {
    const token = localStorage.getItem('quink_token');
    const res = await fetch(`/api/ai/chat/conversations/${convId.value}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ question: text }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'AI 调用失败' }));
      messages.value.push({ id: 'err', role: 'assistant', content: err.error || 'AI 调用失败' });
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let aiMsgId = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'delta') {
            fullContent += data.content;
            streamingContent.value = fullContent;
            scrollToBottom();
          } else if (data.type === 'done') {
            aiMsgId = data.messageId || '';
          } else if (data.type === 'error') {
            fullContent += `\n\n**错误**: ${data.error}`;
          }
        } catch {}
      }
    }

    let html: string | undefined;
    const renderText = stripOuterCodeFence(parseThinking(fullContent).answer || fullContent);
    try { html = await Vditor.md2html(renderText, { cdn: '/vditor' } as any); } catch {}
    messages.value.push({ id: aiMsgId || 'ai', role: 'assistant', content: fullContent, html });
    streamingContent.value = '';
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      messages.value.push({ id: 'err', role: 'assistant', content: err.message || 'AI 调用失败' });
    }
  } finally {
    loading.value = false;
    scrollToBottom();
  }
}

function scrollToBottom() {
  nextTick(() => { if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight; });
}

function handleInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function newChat() {
  convId.value = '';
  messages.value = [];
  streamingContent.value = '';
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

onUnmounted(() => { document.removeEventListener('keydown', onGlobalKeydown); });
</script>

<template>
  <div class="h-full flex flex-col select-none">
    <!-- Title bar -->
    <div class="flex items-center justify-between px-4 py-2 shrink-0" style="-webkit-app-region: drag; background: rgb(var(--c-sidebar))">
      <span class="text-xs font-semibold inline-flex items-center gap-1.5" style="color: var(--sb-text)">
        <PhSparkle size="0.875rem" weight="fill" />
        <span>AI 对话</span>
      </span>
      <div class="flex items-center gap-2" style="-webkit-app-region: no-drag">
        <button @click="newChat" class="text-[10px] px-2 py-0.5 rounded hover:bg-white/10" style="color: var(--sb-dim)">新对话</button>
        <span class="text-[10px]" style="color: var(--sb-dim)">Esc 关闭</span>
      </div>
    </div>

    <div v-if="notLoggedIn" class="flex-1 flex items-center justify-center bg-white">
      <p class="text-gray-500 text-sm">请先在主窗口登录</p>
    </div>

    <template v-else>
      <div ref="messagesEl" class="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-white">
        <div v-if="messages.length === 0 && !streamingContent" class="text-center py-8">
          <div class="mb-2 flex justify-center text-gray-300">
            <PhSparkle size="2rem" weight="fill" />
          </div>
          <p class="text-gray-400 text-xs">问我任何问题</p>
        </div>

        <div v-for="msg in messages" :key="msg.id" class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
          <div class="max-w-[85%] px-3 py-2 rounded-2xl text-sm"
            :class="msg.role === 'user' ? 'bg-primary text-white rounded-br-md' : 'bg-gray-100 text-gray-700 rounded-bl-md'">
            <div v-if="msg.html" class="note-content prose prose-sm max-w-none" v-html="msg.html" />
            <template v-else>{{ parseThinking(msg.content).answer || msg.content }}</template>
          </div>
        </div>

        <div v-if="streamingContent" class="flex justify-start">
          <div class="max-w-[85%] px-3 py-2 bg-gray-100 text-gray-700 rounded-2xl rounded-bl-md text-sm whitespace-pre-wrap">{{ parseThinking(streamingContent).answer || streamingContent }}<span class="animate-pulse">▊</span></div>
        </div>

        <div v-if="loading && !streamingContent" class="flex justify-start">
          <div class="bg-gray-100 text-gray-400 px-3 py-2 rounded-2xl rounded-bl-md text-sm">思考中...</div>
        </div>
      </div>

      <div class="px-3 py-2 border-t border-gray-100 bg-white shrink-0">
        <div class="flex gap-2 items-end">
          <input ref="inputEl" v-model="query" @keydown="handleInputKeydown" placeholder="问点什么..."
            class="flex-1 px-3 py-2 bg-gray-50 border-0 rounded-full text-sm outline-none focus:bg-white focus:ring-2 focus:ring-primary/30" />
          <button v-if="loading" @click="loading = false" class="p-2 rounded-full border border-gray-200 text-gray-500 hover:text-red-500 shrink-0">
            <PhStop size="1rem" weight="fill" />
          </button>
          <button v-else @click="sendMessage" :disabled="!query.trim()"
            class="p-2 rounded-full text-white disabled:opacity-40 shrink-0" style="background: rgb(var(--c-accent))">
            <PhPaperPlaneTilt size="1rem" weight="fill" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
