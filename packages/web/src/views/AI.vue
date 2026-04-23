<script setup lang="ts">
import { ref, onMounted, nextTick, watch } from 'vue';
import { api } from '@/api';
import Vditor from 'vditor';
import { useRouter, useRoute } from 'vue-router';

interface Conversation { id: string; title: string; createdAt: string; updatedAt: string; }
interface Message { id: string; role: 'user' | 'assistant'; content: string; sources: string[]; html?: string; }

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
      if (msg.role === 'assistant') {
        try { html = await Vditor.md2html(msg.content, { cdn: '/vditor' }); } catch {}
      }
      messages.value.push({ ...msg, role: msg.role as 'user' | 'assistant', sources: msg.sources || [], html });
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
          if (data.type === 'delta') {
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
    try { html = await Vditor.md2html(fullContent, { cdn: '/vditor' }); } catch {}
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
              <div v-if="msg.html" class="note-content prose prose-sm max-w-none" v-html="msg.html" />
              <template v-else>{{ msg.content }}</template>
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

        <!-- 流式输出中 -->
        <div v-if="streamingMap.get(currentConvId)" class="flex justify-start">
          <div class="max-w-[80%] px-4 py-3 bg-white border border-gray-100 text-gray-700 rounded-2xl rounded-bl-md shadow-sm text-sm">
            <div class="note-content prose prose-sm max-w-none whitespace-pre-wrap">{{ streamingMap.get(currentConvId) }}<span class="animate-pulse">▊</span></div>
          </div>
        </div>

        <!-- loading -->
        <div v-if="loadingConvs.has(currentConvId) && !streamingMap.get(currentConvId)" class="flex justify-start">
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
