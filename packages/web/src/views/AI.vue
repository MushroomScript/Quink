<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { api } from '@/api';
import Vditor from 'vditor';

const query = ref('');
const messages = ref<{ role: 'user' | 'ai'; content: string; html?: string }[]>([]);
const loading = ref(false);
const messagesEl = ref<HTMLDivElement>();

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

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Messages -->
    <div ref="messagesEl" class="flex-1 overflow-y-auto px-4 md:px-6 py-6 space-y-4">
      <div v-if="messages.length === 0" class="text-center py-16">
        <div class="text-4xl mb-3">🤖</div>
        <p class="text-gray-500 text-sm">问我任何关于你笔记的问题</p>
        <p class="text-gray-400 text-xs mt-2">例如：</p>
        <div class="flex flex-wrap justify-center gap-2 mt-3">
          <button v-for="q in ['我之前记过什么？', '总结一下我的待办', '有什么编程相关的笔记？']" :key="q"
            @click="query = q; sendMessage()"
            class="px-3 py-1.5 text-xs rounded-full border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors">
            {{ q }}
          </button>
        </div>
      </div>

      <div v-for="(msg, i) in messages" :key="i" class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
        <div class="max-w-[80%] px-4 py-3 rounded-2xl text-sm"
          :class="msg.role === 'user' ? 'bg-primary text-white rounded-br-md' : 'bg-white border border-gray-100 text-gray-700 rounded-bl-md shadow-sm'">
          <div v-if="msg.html" class="note-content prose prose-sm max-w-none" v-html="msg.html" />
          <template v-else>{{ msg.content }}</template>
        </div>
      </div>

      <div v-if="loading" class="flex justify-start">
        <div class="bg-white border border-gray-100 text-gray-400 px-4 py-3 rounded-2xl rounded-bl-md text-sm shadow-sm">
          <span class="inline-flex gap-1">
            <span class="animate-bounce" style="animation-delay: 0ms">·</span>
            <span class="animate-bounce" style="animation-delay: 150ms">·</span>
            <span class="animate-bounce" style="animation-delay: 300ms">·</span>
          </span>
          思考中
        </div>
      </div>
    </div>

    <!-- Input -->
    <div class="px-4 md:px-6 py-3 border-t border-gray-100">
      <div class="flex gap-2">
        <textarea v-model="query" @keydown="handleKeydown" placeholder="问点什么..." rows="1"
          class="flex-1 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-primary resize-none" />
        <button @click="sendMessage" :disabled="!query.trim() || loading"
          class="px-5 py-2.5 bg-primary text-white text-sm font-medium rounded-xl hover:bg-primary-dark disabled:opacity-40 transition-colors shrink-0">
          发送
        </button>
      </div>
    </div>
  </div>
</template>
