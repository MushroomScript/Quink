<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { api, isLoggedIn } from '@/api';
import Vditor from 'vditor';
import { PhSparkle, PhStop, PhPaperPlaneTilt, PhXCircle } from '@phosphor-icons/vue';
import { resolveMarkdownFileUrls } from '@/utils/fileUrl';
import { backendBaseUrl } from '@/utils/backendUrl';

// setup 顶层同步设主题（在 Vue 第一次 render 前），让窗口 show 时就是正确主题色
document.documentElement.setAttribute('data-theme', localStorage.getItem('quink_theme') || 'blueberry');
// 显示比例 (zoom) 由 Electron 主进程 webContents.setZoomFactor 统一控制, renderer 不再操作 fontSize

const auth = useAuthStore();
const query = ref('');
const messages = ref<{ id: string; role: 'user' | 'assistant'; content: string; html?: string }[]>([]);
const loading = ref(false);
const streamingContent = ref('');
const notLoggedIn = ref(false);
const messagesEl = ref<HTMLDivElement>();
const inputEl = ref<HTMLInputElement>();
const convId = ref('');

// AiChat 窗口专属持久会话: 每次唤出都恢复上次对话, 点"新对话"才换新.
// 用 localStorage 而非 sessionStorage: sessionStorage 跟窗口生命周期绑, sync-theme 触发 destroy 重建后丢.
// key 跟主窗口 AI.vue 的 `quink_ai_conv` (sessionStorage) 隔离, 两边对话不互串.
const AICHAT_CONV_KEY = 'quink_aichat_conv_id';

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
    try { localStorage.setItem(AICHAT_CONV_KEY, convId.value); } catch {}
  }
}

// 把后端返回的一条 message 渲染成 AiChat 内 messages 格式 (assistant 走 md2html, user 不渲染)
async function renderHistoryMessage(m: { id: string; role: string; content: string }) {
  const role = m.role === 'assistant' ? 'assistant' as const : 'user' as const;
  if (role === 'user') return { id: m.id, role, content: m.content };
  let html: string | undefined;
  const renderText = stripOuterCodeFence(parseThinking(m.content).answer || m.content);
  try { html = await Vditor.md2html(resolveMarkdownFileUrls(renderText), { cdn: '/vditor' } as any); } catch {}
  return { id: m.id, role, content: m.content, html };
}

async function loadPersistedConversation() {
  let savedId = '';
  try { savedId = localStorage.getItem(AICHAT_CONV_KEY) || ''; } catch {}
  if (!savedId) return;
  try {
    const res = await api.getMessages(savedId);
    // 服务端校验通过 (user 拥有该 conv) 才走到这里, 即使 messages 为空也保留 convId 让后续发消息延续这条会话
    convId.value = savedId;
    const rendered = await Promise.all(res.data.map(renderHistoryMessage));
    messages.value = rendered;
    scrollToBottom();
  } catch {
    // conv 被服务端删 / 不存在 / 网络异常: 静默清 localStorage 走新会话流程, 不打扰用户
    try { localStorage.removeItem(AICHAT_CONV_KEY); } catch {}
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
    // AI chat 流式响应直连 backend 绕开 vite proxy. 详见 utils/backendUrl.ts
    const res = await fetch(`${backendBaseUrl()}/api/ai/chat/conversations/${convId.value}/messages`, {
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
    try { html = await Vditor.md2html(resolveMarkdownFileUrls(renderText), { cdn: '/vditor' } as any); } catch {}
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
  try { localStorage.removeItem(AICHAT_CONV_KEY); } catch {}
}

function closeWindow() {
  try { (window as any).quink?.hideWindow(); } catch {}
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeWindow();
}

// Ctrl+滚轮 zoom 由 main 端 webContents.on('zoom-changed') 拦截 (preventDefault 阻 Chromium 内置 layout zoom),
// 不在 renderer 注册 wheel hook 避免 zoom 双触发
onMounted(async () => {
  const user = await auth.fetchMe();
  if (!user) notLoggedIn.value = true;
  const theme = user?.preferences?.theme || 'blueberry';
  document.documentElement.setAttribute('data-theme', theme);
  document.addEventListener('keydown', onGlobalKeydown);
  setTimeout(() => inputEl.value?.focus(), 500);
  // 登录态下恢复上次的 AiChat 专属会话 (跟 fetchMe 顺序: fetchMe 拿到 token 后才能调 getMessages)
  if (user) loadPersistedConversation();
  // 每次窗口显示时同步主题 + 重新 focus 输入框. 持久窗口 hide→show 时 onMounted 不重跑,
  // 必须靠 window-shown IPC 触发 DOM .focus() 让 Chromium 重新激活 hwnd 把 OS 焦点从原窗口切过来
  // (跟 Capture.vue 同套机制, 详见 packages/desktop/CLAUDE.md "Capture / AiChat 失焦不自动 hide" 邻段)
  try {
    (window as any).quink?.onWindowShown?.(() => {
      const t = localStorage.getItem('quink_theme') || 'blueberry';
      document.documentElement.setAttribute('data-theme', t);
      setTimeout(() => inputEl.value?.focus(), 50);
    });
  } catch {}
  // zoom 同步: 主窗口改显示比例时主进程直接 setZoomFactor 应用到 AiChat 窗口, renderer 不再需要监听 + 自行操作 fontSize
});

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown);
});
</script>

<style scoped>
.aichat-close-btn {
  width: 1.25rem;
  height: 1.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--sb-dim);
  transition: color 0.15s;
}
.aichat-close-btn:hover {
  color: #f87171;
}
</style>

<template>
  <div class="h-full flex flex-col select-none">
    <!-- Title bar -->
    <div class="flex items-center justify-between px-4 py-2 shrink-0" style="-webkit-app-region: drag; background: rgb(var(--c-sidebar))">
      <span class="text-xs font-semibold inline-flex items-center gap-1.5" style="color: var(--sb-text)">
        <PhSparkle size="0.875rem" weight="fill" />
        <span>AI 对话</span>
      </span>
      <div class="flex items-center gap-2" style="-webkit-app-region: no-drag">
        <button @click="newChat" class="text-xs font-medium px-2.5 py-1 rounded hover:opacity-80 transition-opacity" style="background: var(--sb-active-bg); color: var(--sb-active-text)">新对话</button>
        <button @click="closeWindow" class="aichat-close-btn" title="关闭">
          <PhXCircle size="1rem" weight="fill" />
        </button>
      </div>
    </div>

    <div v-if="notLoggedIn" class="flex-1 flex items-center justify-center bg-white">
      <p class="text-gray-500 text-sm">请先在主窗口登录</p>
    </div>

    <template v-else>
      <div ref="messagesEl" class="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3 bg-white">
        <div v-if="messages.length === 0 && !streamingContent" class="text-center py-8">
          <div class="mb-2 flex justify-center text-gray-300">
            <PhSparkle size="2rem" weight="fill" />
          </div>
          <p class="text-gray-400 text-xs">问我任何问题</p>
        </div>

        <div v-for="msg in messages" :key="msg.id" class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
          <div class="max-w-[85%] px-3 py-2 rounded-2xl text-sm"
            :class="msg.role === 'user' ? 'bg-primary text-white rounded-br-md' : 'bg-gray-100 text-gray-700 rounded-bl-md'">
            <div v-if="msg.html" class="note-content">
              <div class="vditor-reset" v-html="msg.html" />
            </div>
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
