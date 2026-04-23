<script setup lang="ts">
import { ref, onMounted, nextTick, watch } from 'vue';
import { api } from '@/api';
import Vditor from 'vditor';
import { useRouter, useRoute } from 'vue-router';

interface Conversation { id: string; title: string; createdAt: string; updatedAt: string; }
interface Message { id: string; role: 'user' | 'assistant'; content: string; sources: string[]; html?: string; thinkingHtml?: string; }

const router = useRouter();
const route = useRoute();
const conversations = ref<Conversation[]>([]);
const currentConvId = ref('');
const messages = ref<Message[]>([]);
const query = ref('');
const loadingConvs = ref(new Set<string>());
const streamingMap = ref(new Map<string, string>());
const messagesEl = ref<HTMLDivElement>();
const editingTitle = ref('');
const editingConvId = ref('');
const showSources = ref<Record<string, boolean>>({});
const sourceNotes = ref<Record<string, { id: string; summary: string; content: string }[]>>({});
const toolCallStatus = ref(new Map<string, string>());
const TOOL_LABELS: Record<string, string> = {
  search_notes: '搜索笔记', get_note: '查看笔记', get_todos: '获取待办',
  get_recent_notes: '获取最近笔记', get_categories: '获取分类', get_tags: '获取标签',
  get_stats: '获取统计', get_voice_transcription: '获取语音转写',
  create_note: '创建笔记', update_note: '更新笔记',
};

onMounted(async () => {
  await loadConversations();
  const convId = route.query.conv as string;
  if (convId && conversations.value.find(c => c.id === convId)) {
    await selectConversation(convId);
    // 恢复滚动位置（从笔记详情返回时）
    if (savedScrollTop.value && messagesEl.value) {
      nextTick(() => { if (messagesEl.value) messagesEl.value.scrollTop = savedScrollTop.value; });
    }
  }
});

async function loadConversations() {
  try {
    const res = await api.getConversations();
    conversations.value = res.data;
  } catch {}
}

async function newConversation() {
  try {
    const res = await api.createConversation();
    conversations.value.unshift(res.data);
    await selectConversation(res.data.id);
  } catch {}
}

async function selectConversation(id: string) {
  currentConvId.value = id;
  router.replace({ query: { conv: id } });
  messages.value = [];
  try {
    const res = await api.getMessages(id);
    for (const msg of res.data) {
      let html: string | undefined;
      let thinkingHtml: string | undefined;
      if (msg.role === 'assistant') {
        const { answer } = parseThinking(msg.content);
        const renderContent = answer || msg.content;
        try { html = await Vditor.md2html(renderContent, { cdn: '/vditor' }); } catch {}
      }
      messages.value.push({ ...msg, role: msg.role as 'user' | 'assistant', sources: msg.sources || [], html, thinkingHtml });
    }
    scrollToBottom();
  } catch {}
}

async function deleteConversation(id: string) {
  try {
    await api.deleteConversation(id);
    conversations.value = conversations.value.filter(c => c.id !== id);
    if (currentConvId.value === id) {
      currentConvId.value = '';
      messages.value = [];
    }
  } catch {}
}

function startEditTitle(conv: Conversation) {
  editingConvId.value = conv.id;
  editingTitle.value = conv.title;
}

async function saveTitle() {
  if (!editingConvId.value || !editingTitle.value.trim()) { editingConvId.value = ''; return; }
  try {
    await api.updateConversation(editingConvId.value, { title: editingTitle.value.trim() });
    const conv = conversations.value.find(c => c.id === editingConvId.value);
    if (conv) conv.title = editingTitle.value.trim();
  } catch {}
  editingConvId.value = '';
}

async function sendMessage() {
  const text = query.value.trim();
  if (!text) return;
  if (!currentConvId.value) await newConversation();
  const targetConvId = currentConvId.value;
  if (loadingConvs.value.has(targetConvId)) return;

  messages.value.push({ id: 'temp-user', role: 'user', content: text, sources: [] });
  query.value = '';
  loadingConvs.value.add(targetConvId);
  streamingMap.value.set(targetConvId, '');
  scrollToBottom();

  try {
    const token = localStorage.getItem('quink_token');
    const res = await fetch(`/api/ai/chat/conversations/${targetConvId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ question: text }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'AI 调用失败' }));
      if (currentConvId.value === targetConvId) {
        messages.value.push({ id: 'err', role: 'assistant', content: err.error || 'AI 调用失败', sources: [] });
      }
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let aiSources: string[] = [];
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
          if (data.type === 'tool_call') {
            toolCallStatus.value.set(targetConvId, TOOL_LABELS[data.name] || data.name);
          } else if (data.type === 'delta') {
            toolCallStatus.value.delete(targetConvId);
            fullContent += data.content;
            streamingMap.value.set(targetConvId, fullContent);
            if (currentConvId.value === targetConvId) scrollToBottom();
          } else if (data.type === 'done') {
            aiSources = data.sources || [];
            aiMsgId = data.messageId || '';
          } else if (data.type === 'title') {
            const conv = conversations.value.find(c => c.id === targetConvId);
            if (conv) conv.title = data.title;
          } else if (data.type === 'error') {
            fullContent += `\n\n**错误**: ${data.error}`;
          }
        } catch {}
      }
    }

    let html: string | undefined;
    const { answer: answerText } = parseThinking(fullContent);
    const renderText = answerText || fullContent;
    try { html = await Vditor.md2html(renderText, { cdn: '/vditor' }); } catch {}
    if (currentConvId.value === targetConvId) {
      messages.value.push({ id: aiMsgId || 'ai-resp', role: 'assistant', content: fullContent, sources: aiSources, html });
    }
  } catch (err: any) {
    if (currentConvId.value === targetConvId) {
      messages.value.push({ id: 'err', role: 'assistant', content: err.message || 'AI 调用失败', sources: [] });
    }
  } finally {
    loadingConvs.value.delete(targetConvId);
    streamingMap.value.delete(targetConvId);
    toolCallStatus.value.delete(targetConvId);
    if (currentConvId.value === targetConvId) scrollToBottom();
  }
}

async function toggleSources(msgId: string, noteIds: string[]) {
  showSources.value[msgId] = !showSources.value[msgId];
  if (showSources.value[msgId] && !sourceNotes.value[msgId]) {
    const notes: { id: string; summary: string; content: string }[] = [];
    for (const nid of noteIds.slice(0, 5)) {
      try {
        const res = await api.getNote(nid);
        notes.push({ id: nid, summary: res.data.summary || '', content: res.data.content.slice(0, 100) });
      } catch {}
    }
    sourceNotes.value[msgId] = notes;
  }
}

function parseThinking(text: string): { thinking: string; answer: string } {
  const thinkMatch = text.match(/<think>([\s\S]*?)(<\/think>|$)/);
  if (!thinkMatch) return { thinking: '', answer: text };
  const thinking = thinkMatch[1].trim();
  const closed = text.includes('</think>');
  const answer = closed ? text.replace(/<think>[\s\S]*?<\/think>/, '').trim() : '';
  return { thinking, answer };
}

const savedScrollTop = ref(0);

function goToNote(noteId: string) {
  if (messagesEl.value) savedScrollTop.value = messagesEl.value.scrollTop;
  router.push(`/note/${noteId}`);
}

function scrollToBottom() {
  nextTick(() => { if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight; });
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

const currentConv = ref<Conversation | null>(null);
watch(currentConvId, (id) => { currentConv.value = conversations.value.find(c => c.id === id) || null; });
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <!-- 左侧：对话列表 -->
    <div class="w-56 shrink-0 border-r border-gray-100 flex flex-col bg-gray-50/50 hidden md:flex">
      <div class="p-3">
        <button @click="newConversation" class="w-full px-3 py-2 text-xs font-medium rounded-lg transition-colors text-white" style="background: rgb(var(--c-accent))">
          + 新对话
        </button>
      </div>
      <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        <div v-for="conv in conversations" :key="conv.id"
          @click="selectConversation(conv.id)"
          class="group flex items-center gap-1 px-3 py-2 rounded-lg cursor-pointer text-xs transition-colors"
          :class="currentConvId === conv.id ? 'bg-white shadow-sm font-medium text-gray-800' : 'text-gray-500 hover:bg-white/60'">
          <div class="flex-1 min-w-0">
            <div v-if="editingConvId === conv.id" class="flex">
              <input v-model="editingTitle" @blur="saveTitle" @keydown.enter="saveTitle" class="w-full px-1 py-0.5 border border-gray-200 rounded text-xs outline-none" autofocus @click.stop />
            </div>
            <div v-else @dblclick.stop="startEditTitle(conv)" class="truncate">{{ conv.title }}</div>
            <div class="text-[10px] text-gray-400 mt-0.5">{{ conv.updatedAt?.slice(5, 16).replace('T', ' ') }}</div>
          </div>
          <button @click.stop="deleteConversation(conv.id)" class="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-400 shrink-0 transition-opacity">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div v-if="conversations.length === 0" class="text-center py-8 text-xs text-gray-400">暂无对话</div>
      </div>
    </div>

    <!-- 右侧：消息区 -->
    <div class="flex-1 flex flex-col min-w-0">
      <div ref="messagesEl" class="flex-1 overflow-y-auto px-4 md:px-6 py-6 space-y-4">
        <!-- 空状态 -->
        <div v-if="!currentConvId || messages.length === 0" class="text-center py-16">
          <div class="text-4xl mb-3">🤖</div>
          <p class="text-gray-500 text-sm">问我任何问题，可以关于你的笔记，也可以聊别的</p>
          <div class="flex flex-wrap justify-center gap-2 mt-3">
            <button v-for="q in ['我之前记过什么？', '总结一下我的待办', '帮我解释一下量子计算']" :key="q"
              @click="query = q; sendMessage()"
              class="px-3 py-1.5 text-xs rounded-full border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors">
              {{ q }}
            </button>
          </div>
        </div>

        <!-- 消息列表 -->
        <div v-for="msg in messages" :key="msg.id" class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
          <div class="max-w-[80%]">
            <div class="px-4 py-3 rounded-2xl text-sm"
              :class="msg.role === 'user' ? 'bg-primary text-white rounded-br-md' : 'bg-white border border-gray-100 text-gray-700 rounded-bl-md shadow-sm'">
              <!-- 思考模型：折叠的思考过程 -->
              <details v-if="msg.role === 'assistant' && parseThinking(msg.content).thinking" class="mb-2">
                <summary class="text-xs text-gray-400 cursor-pointer hover:text-gray-500 select-none">查看思考过程</summary>
                <div class="mt-1 px-3 py-2 bg-gray-50 rounded-lg text-xs text-gray-400 italic whitespace-pre-wrap max-h-40 overflow-y-auto">{{ parseThinking(msg.content).thinking }}</div>
              </details>
              <div v-if="msg.html" class="note-content prose prose-sm max-w-none" v-html="msg.thinkingHtml || msg.html" />
              <template v-else>{{ parseThinking(msg.content).answer || msg.content }}</template>
            </div>
            <!-- 来源标注 -->
            <div v-if="msg.role === 'assistant' && msg.sources?.length" class="mt-1.5 ml-1">
              <button @click="toggleSources(msg.id, msg.sources)" class="text-[11px] text-gray-400 hover:text-gray-600 transition-colors">
                📎 参考了 {{ msg.sources.length }} 条笔记
                <span class="text-[10px]">{{ showSources[msg.id] ? '▲' : '▼' }}</span>
              </button>
              <div v-if="showSources[msg.id] && sourceNotes[msg.id]" class="mt-1 space-y-1">
                <div v-for="note in sourceNotes[msg.id]" :key="note.id"
                  @click="goToNote(note.id)"
                  class="px-3 py-1.5 bg-gray-50 rounded-lg text-xs text-gray-500 cursor-pointer hover:bg-gray-100 transition-colors truncate">
                  {{ note.summary || note.content }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 工具调用状态 -->
        <div v-if="toolCallStatus.get(currentConvId)" class="flex justify-start">
          <div class="bg-white border border-gray-100 text-gray-400 px-4 py-3 rounded-2xl rounded-bl-md text-sm shadow-sm flex items-center gap-2">
            <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            正在{{ toolCallStatus.get(currentConvId) }}...
          </div>
        </div>

        <!-- 流式输出中（含思考模型解析） -->
        <div v-if="streamingMap.get(currentConvId)" class="flex justify-start">
          <div class="max-w-[80%] px-4 py-3 bg-white border border-gray-100 text-gray-700 rounded-2xl rounded-bl-md shadow-sm text-sm">
            <!-- 思考过程 -->
            <div v-if="parseThinking(streamingMap.get(currentConvId) || '').thinking" class="mb-2 px-3 py-2 bg-gray-50 rounded-lg text-xs text-gray-400 italic">
              <div class="font-medium text-gray-500 mb-1 flex items-center gap-1">
                <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                思考中...
              </div>
              <div class="whitespace-pre-wrap max-h-32 overflow-y-auto">{{ parseThinking(streamingMap.get(currentConvId) || '').thinking }}</div>
            </div>
            <!-- 正式回答 -->
            <div v-if="parseThinking(streamingMap.get(currentConvId) || '').answer" class="note-content prose prose-sm max-w-none whitespace-pre-wrap">{{ parseThinking(streamingMap.get(currentConvId) || '').answer }}<span class="animate-pulse">▊</span></div>
            <div v-else-if="!parseThinking(streamingMap.get(currentConvId) || '').thinking" class="note-content prose prose-sm max-w-none whitespace-pre-wrap">{{ streamingMap.get(currentConvId) }}<span class="animate-pulse">▊</span></div>
          </div>
        </div>

        <!-- loading（无工具调用、无流式时显示） -->
        <div v-if="loadingConvs.has(currentConvId) && !streamingMap.get(currentConvId) && !toolCallStatus.get(currentConvId)" class="flex justify-start">
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

      <!-- 输入框 -->
      <div class="px-4 md:px-6 py-3 border-t border-gray-100">
        <div class="flex gap-2">
          <textarea v-model="query" @keydown="handleKeydown" placeholder="问点什么..." rows="1"
            class="flex-1 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-primary resize-none" />
          <button @click="sendMessage" :disabled="!query.trim() || loadingConvs.has(currentConvId)"
            class="px-5 py-2.5 text-white text-sm font-medium rounded-xl disabled:opacity-40 transition-colors shrink-0"
            style="background: rgb(var(--c-accent))">
            发送
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
