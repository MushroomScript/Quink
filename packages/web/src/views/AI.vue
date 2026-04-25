<script setup lang="ts">
defineOptions({ name: 'ai-page' });
import { ref, onMounted, onActivated, onDeactivated, nextTick, watch } from 'vue';
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
const confirmDeleteId = ref('');
const searchConv = ref('');
const showMobileConvs = ref(false);
const abortControllers = new Map<string, AbortController>();
const editingMsgId = ref('');
const editingMsgText = ref('');
const queryEl = ref<HTMLTextAreaElement>();
const showFindBar = ref(false);
const findQuery = ref('');
const findMatches = ref(0);
const findCurrent = ref(0);

// 每个对话独立状态
const convDrafts = new Map<string, string>();
const convFindState = new Map<string, { show: boolean; query: string }>();

function saveConvState() {
  const id = currentConvId.value;
  if (!id) return;
  convDrafts.set(id, query.value);
  convFindState.set(id, { show: showFindBar.value, query: findQuery.value });
  // 持久化
  const drafts: Record<string, string> = {};
  convDrafts.forEach((v, k) => { if (v) drafts[k] = v; });
  sessionStorage.setItem('quink_ai_drafts', JSON.stringify(drafts));
}

function restoreConvState(id: string) {
  query.value = convDrafts.get(id) || '';
  const fs = convFindState.get(id);
  if (fs) {
    showFindBar.value = fs.show;
    findQuery.value = fs.query;
    if (fs.show && fs.query) nextTick(() => doFind());
  } else {
    showFindBar.value = false;
    findQuery.value = '';
    clearHighlights();
  }
  nextTick(autoGrowTextarea);
}

// 页面加载时从 sessionStorage 恢复草稿
try {
  const saved = JSON.parse(sessionStorage.getItem('quink_ai_drafts') || '{}');
  Object.entries(saved).forEach(([k, v]) => convDrafts.set(k, v as string));
} catch {}
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

let savedScroll = 0;

onMounted(async () => {
  await loadConversations();
  const convId = (route.query.conv as string) || sessionStorage.getItem('quink_ai_conv') || '';
  if (convId && conversations.value.find(c => c.id === convId)) {
    await selectConversation(convId);
  }
  watch(messagesEl, (el) => {
    if (el) el.addEventListener('scroll', () => { savedScroll = el.scrollTop; }, { passive: true });
  }, { immediate: true });
  window.addEventListener('quink-refresh', loadConversations);
  document.addEventListener('keydown', onGlobalKeydown);
});

onDeactivated(() => {
  saveConvState();
  if (messagesEl.value) messagesEl.value.style.visibility = 'hidden';
});

onActivated(() => {
  requestAnimationFrame(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = savedScroll;
      messagesEl.value.style.visibility = '';
    }
  });
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

const filteredConversations = ref<Conversation[]>([]);

let searchTimer: ReturnType<typeof setTimeout>;
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = searchConv.value.trim();
  if (!q) {
    filteredConversations.value = conversations.value;
    clearHighlights();
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const res = await api.getConversations({ search: q });
      filteredConversations.value = res.data;
      if (!res.data.length) return;
      // 当前对话在结果中 → 原地高亮跳转
      const inCurrent = res.data.find(c => c.id === currentConvId.value);
      if (inCurrent) {
        nextTick(() => highlightAndJump(q));
      } else {
        // 打开第一个结果
        await selectConversation(res.data[0].id);
        nextTick(() => highlightAndJump(q));
      }
    } catch {
      filteredConversations.value = conversations.value;
    }
  }, 300);
}

function highlightAndJump(keyword: string) {
  clearHighlights();
  if (!messagesEl.value || !keyword) return;
  const walker = document.createTreeWalker(messagesEl.value, NodeFilter.SHOW_TEXT);
  const kw = keyword.toLowerCase();
  const nodes: { node: Text; index: number }[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.textContent || '';
    let idx = text.toLowerCase().indexOf(kw);
    while (idx >= 0) {
      nodes.push({ node, index: idx });
      idx = text.toLowerCase().indexOf(kw, idx + keyword.length);
    }
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const { node, index } = nodes[i];
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + keyword.length);
    const mark = document.createElement('mark');
    mark.className = 'find-hl';
    range.surroundContents(mark);
  }
  // 跳到第一个匹配
  const first = messagesEl.value.querySelector('mark.find-hl');
  if (first) {
    first.classList.add('find-hl-active');
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

async function clearSearchConv() {
  searchConv.value = '';
  clearHighlights();
  await loadConversations();
}

watch(conversations, () => {
  if (!searchConv.value.trim()) filteredConversations.value = conversations.value;
}, { immediate: true });

async function selectConversation(id: string) {
  saveConvState();
  clearHighlights();
  currentConvId.value = id;
  sessionStorage.setItem('quink_ai_conv', id);
  showMobileConvs.value = false;
  router.replace({ query: { conv: id } });
  messages.value = [];
  try {
    const res = await api.getMessages(id);
    for (const msg of res.data) {
      let html: string | undefined;
      let thinkingHtml: string | undefined;
      if (msg.role === 'assistant') {
        const { answer } = parseThinking(msg.content);
        const renderContent = stripOuterCodeFence(answer || msg.content);
        try { html = await Vditor.md2html(renderContent, { cdn: '/vditor' }); } catch {}
      }
      messages.value.push({ ...msg, role: msg.role as 'user' | 'assistant', sources: msg.sources || [], html, thinkingHtml });
    }
    scrollToBottom();
    // 恢复该对话的独立状态（输入框草稿 + 查找栏）
    restoreConvState(id);
    // 如果对话列表搜索有关键词，高亮跳转
    if (searchConv.value.trim()) {
      nextTick(() => highlightAndJump(searchConv.value.trim()));
    }
  } catch {}
}

function askDeleteConv(id: string) {
  confirmDeleteId.value = id;
}

async function deleteConversation(id: string) {
  confirmDeleteId.value = '';
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
  convDrafts.delete(targetConvId);
  saveConvState();
  nextTick(() => { if (queryEl.value) { queryEl.value.style.height = 'auto'; queryEl.value.style.overflow = 'hidden'; } });
  loadingConvs.value.add(targetConvId);
  streamingMap.value.set(targetConvId, '');
  scrollToBottom();

  const abortCtrl = new AbortController();
  abortControllers.set(targetConvId, abortCtrl);

  try {
    const token = localStorage.getItem('quink_token');
    const res = await fetch(`/api/ai/chat/conversations/${targetConvId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ question: text }),
      signal: abortCtrl.signal,
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
    const renderText = stripOuterCodeFence(answerText || fullContent);
    try { html = await Vditor.md2html(renderText, { cdn: '/vditor' }); } catch {}
    if (currentConvId.value === targetConvId) {
      messages.value.push({ id: aiMsgId || 'ai-resp', role: 'assistant', content: fullContent, sources: aiSources, html });
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && currentConvId.value === targetConvId) {
      messages.value.push({ id: 'err', role: 'assistant', content: err.message || 'AI 调用失败', sources: [] });
    }
  } finally {
    abortControllers.delete(targetConvId);
    loadingConvs.value.delete(targetConvId);
    streamingMap.value.delete(targetConvId);
    toolCallStatus.value.delete(targetConvId);
    if (currentConvId.value === targetConvId) scrollToBottom();
  }
}

function stopGeneration() {
  const ctrl = abortControllers.get(currentConvId.value);
  if (ctrl) ctrl.abort();
}

function startEditMsg(msg: Message) {
  editingMsgId.value = msg.id;
  editingMsgText.value = msg.content;
}

async function submitEditMsg(msg: Message) {
  const text = editingMsgText.value.trim();
  editingMsgId.value = '';
  if (!text || text === msg.content) return;
  // 删掉这条及之后的所有消息，重新发送
  const idx = messages.value.findIndex(m => m.id === msg.id);
  if (idx >= 0) messages.value.splice(idx);
  query.value = text;
  await sendMessage();
}

function cancelEditMsg() { editingMsgId.value = ''; }

function stripOuterCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:markdown|md|text)?\n([\s\S]*?)\n```$/);
  return match ? match[1] : text;
}

async function toggleSources(msgId: string, noteIds: string[]) {
  showSources.value[msgId] = !showSources.value[msgId];
  if (showSources.value[msgId] && !sourceNotes.value[msgId]) {
    const notes: { id: string; summary: string; content: string }[] = [];
    for (const nid of noteIds) {
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

function goToNote(noteId: string) {
  router.push(`/note/${noteId}`);
}

function scrollToBottom() {
  nextTick(() => { if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight; });
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); return; }
  nextTick(autoGrowTextarea);
}

let draftTimer: ReturnType<typeof setTimeout>;
function autoGrowTextarea() {
  const el = queryEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.overflow = 'hidden';
  const maxH = Math.floor(window.innerHeight / 3);
  const h = Math.min(el.scrollHeight, maxH);
  el.style.height = h + 'px';
  if (el.scrollHeight > maxH) el.style.overflow = 'auto';
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveConvState, 1000);
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    showFindBar.value = true;
    nextTick(() => {
      const el = document.querySelector('.ai-find-input') as HTMLInputElement;
      el?.focus();
    });
  }
  if (e.key === 'Escape' && showFindBar.value) {
    closeFindBar();
  }
}

function closeFindBar() {
  showFindBar.value = false;
  findQuery.value = '';
  clearHighlights();
}

function clearHighlights() {
  if (!messagesEl.value) return;
  messagesEl.value.querySelectorAll('mark.find-hl').forEach(m => {
    const parent = m.parentNode!;
    parent.replaceChild(document.createTextNode(m.textContent || ''), m);
    parent.normalize();
  });
  findMatches.value = 0;
  findCurrent.value = 0;
}

function doFind() {
  clearHighlights();
  const q = findQuery.value.trim();
  if (!q || !messagesEl.value) return;
  const walker = document.createTreeWalker(messagesEl.value, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; index: number }[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.textContent || '';
    let idx = text.toLowerCase().indexOf(q.toLowerCase());
    while (idx >= 0) {
      nodes.push({ node, index: idx });
      idx = text.toLowerCase().indexOf(q.toLowerCase(), idx + q.length);
    }
  }
  // 从后往前替换避免偏移
  for (let i = nodes.length - 1; i >= 0; i--) {
    const { node, index } = nodes[i];
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + q.length);
    const mark = document.createElement('mark');
    mark.className = 'find-hl';
    range.surroundContents(mark);
  }
  findMatches.value = nodes.length;
  findCurrent.value = nodes.length ? 1 : 0;
  scrollToFindMatch();
}

function findNext() {
  if (!findMatches.value) return;
  findCurrent.value = findCurrent.value >= findMatches.value ? 1 : findCurrent.value + 1;
  scrollToFindMatch();
}

function findPrev() {
  if (!findMatches.value) return;
  findCurrent.value = findCurrent.value <= 1 ? findMatches.value : findCurrent.value - 1;
  scrollToFindMatch();
}

function scrollToFindMatch() {
  if (!messagesEl.value) return;
  const marks = messagesEl.value.querySelectorAll('mark.find-hl');
  marks.forEach(m => m.classList.remove('find-hl-active'));
  const target = marks[findCurrent.value - 1];
  if (target) {
    target.classList.add('find-hl-active');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

const currentConv = ref<Conversation | null>(null);
watch(currentConvId, (id) => { currentConv.value = conversations.value.find(c => c.id === id) || null; });
</script>

<template>
  <div class="flex h-full overflow-hidden">
    <!-- 左侧：对话列表（桌面端） -->
    <div class="w-56 shrink-0 border-r border-gray-100 flex flex-col bg-gray-50/50 hidden md:flex">
      <div class="p-3 space-y-2">
        <button @click="newConversation" class="w-full px-3 py-2 text-xs font-medium rounded-lg transition-colors text-white" style="background: rgb(var(--c-accent))">
          + 新对话
        </button>
        <div class="relative">
          <input v-model="searchConv" @input="onSearchInput" placeholder="搜索对话..." class="w-full px-2.5 py-1.5 pr-7 bg-white border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/20 placeholder-gray-400" />
          <button v-if="searchConv" @click="clearSearchConv" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        <div v-for="conv in filteredConversations" :key="conv.id"
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
          <button @click.stop="askDeleteConv(conv.id)" class="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-400 shrink-0 transition-opacity">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div v-if="filteredConversations.length === 0" class="text-center py-8 text-xs text-gray-400">{{ searchConv ? '无匹配' : '暂无对话' }}</div>
      </div>
    </div>

    <!-- 手机端对话列表抽屉 -->
    <div v-if="showMobileConvs" class="fixed inset-0 z-50 md:hidden">
      <div class="absolute inset-0 bg-black/40" @click="showMobileConvs = false" />
      <div class="absolute left-0 top-0 bottom-0 w-64 bg-white shadow-2xl flex flex-col" @click.stop>
        <div class="p-3 space-y-2">
          <button @click="newConversation" class="w-full px-3 py-2 text-xs font-medium rounded-lg text-white" style="background: rgb(var(--c-accent))">+ 新对话</button>
          <div class="relative">
            <input v-model="searchConv" @input="onSearchInput" placeholder="搜索对话..." class="w-full px-2.5 py-1.5 pr-7 bg-gray-50 border border-gray-200 rounded-lg text-xs outline-none placeholder-gray-400" />
            <button v-if="searchConv" @click="clearSearchConv" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          <div v-for="conv in filteredConversations" :key="conv.id"
            @click="selectConversation(conv.id)"
            class="flex items-center gap-1 px-3 py-2.5 rounded-lg cursor-pointer text-xs"
            :class="currentConvId === conv.id ? 'bg-primary-light font-medium text-primary-dark' : 'text-gray-600'">
            <div class="flex-1 min-w-0 truncate">{{ conv.title }}</div>
            <button @click.stop="askDeleteConv(conv.id)" class="p-0.5 text-gray-400 shrink-0">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 右侧：消息区 -->
    <div class="flex-1 flex flex-col min-w-0">
      <!-- 手机端顶部：对话列表按钮 -->
      <div class="md:hidden flex items-center gap-2 px-3 py-2 border-b border-gray-100">
        <button @click="showMobileConvs = true" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7"/></svg>
        </button>
        <span class="text-xs text-gray-500 truncate">{{ currentConv?.title || 'AI 对话' }}</span>
      </div>
      <!-- Ctrl+F 查找栏 -->
      <div v-if="showFindBar" class="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 bg-gray-50/80">
        <input v-model="findQuery" @input="doFind" @keydown.enter.prevent="findNext" @keydown.escape="closeFindBar"
          class="ai-find-input flex-1 px-2.5 py-1 bg-white border border-gray-200 rounded text-xs outline-none focus:ring-2 focus:ring-primary/20" placeholder="在对话中查找..." />
        <span v-if="findQuery" class="text-[10px] text-gray-400 shrink-0">{{ findCurrent }}/{{ findMatches }}</span>
        <button @click="findPrev" class="p-1 text-gray-400 hover:text-gray-600" title="上一个">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/></svg>
        </button>
        <button @click="findNext" class="p-1 text-gray-400 hover:text-gray-600" title="下一个">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
        </button>
        <button @click="closeFindBar" class="p-1 text-gray-400 hover:text-gray-600">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
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
          <div :class="msg.role === 'user' && editingMsgId === msg.id ? 'w-full max-w-[90%] md:max-w-[70%]' : msg.role === 'user' ? 'max-w-[80%] group' : 'max-w-[80%]'">
            <!-- 用户消息：编辑模式 -->
            <div v-if="msg.role === 'user' && editingMsgId === msg.id" class="flex flex-col gap-1.5">
              <textarea v-model="editingMsgText" rows="3"
                class="px-4 py-2.5 bg-white border border-primary/40 rounded-xl text-sm outline-none resize-none ring-2 ring-primary/20" />
              <div class="flex justify-end gap-1.5">
                <button @click="cancelEditMsg" class="px-3 py-1 text-xs rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50">取消</button>
                <button @click="submitEditMsg(msg)" class="px-3 py-1 text-xs rounded-lg text-white" style="background: rgb(var(--c-accent))">重新发送</button>
              </div>
            </div>
            <!-- 用户消息：正常显示 -->
            <div v-else-if="msg.role === 'user'" class="relative">
              <div class="px-4 py-3 rounded-2xl rounded-br-md text-sm bg-primary text-white whitespace-pre-wrap">{{ msg.content }}</div>
              <button @click="startEditMsg(msg)" class="absolute -left-8 top-1/2 -translate-y-1/2 p-1 rounded-md text-gray-300 hover:text-gray-500 hover:bg-gray-100 opacity-0 group-hover:opacity-100 transition-opacity" title="编辑">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
            </div>
            <!-- AI 消息 -->
            <div v-else class="px-4 py-3 rounded-2xl rounded-bl-md text-sm bg-white border border-gray-100 text-gray-700 shadow-sm">
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
              <div v-show="showSources[msg.id] && sourceNotes[msg.id]" class="mt-1 space-y-1 max-h-60 overflow-y-auto">
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
        <div class="flex gap-2 items-end">
          <div class="flex-1 min-w-0 bg-white border border-gray-200 rounded-xl overflow-hidden focus-within:border-primary transition-colors pt-1.5">
            <textarea ref="queryEl" v-model="query" @keydown="handleKeydown" @input="autoGrowTextarea" placeholder="问点什么..." rows="1"
              class="w-full px-4 pt-1.5 pb-2.5 bg-transparent border-0 text-sm outline-none resize-none"
              style="max-height: 33vh; overflow: hidden" />
          </div>
          <button v-if="loadingConvs.has(currentConvId)" @click="stopGeneration"
            class="p-2.5 rounded-xl border border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-500 hover:border-red-200 transition-colors shrink-0" title="停止生成">
            <svg class="w-4 h-4" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>
          </button>
          <button v-else @click="sendMessage" :disabled="!query.trim()"
            class="p-2.5 rounded-xl text-white disabled:opacity-40 transition-colors shrink-0"
            style="background: rgb(var(--c-accent))" title="发送">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 删除确认弹窗 -->
  <Teleport to="body">
    <div v-if="confirmDeleteId" class="fixed inset-0 z-[200] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" @click="confirmDeleteId = ''" />
      <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
        <p class="text-sm text-gray-700 mb-1">删除对话</p>
        <p class="text-xs text-gray-400 mb-4">删除后无法恢复</p>
        <div class="flex gap-2 justify-center">
          <button @click="confirmDeleteId = ''" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
          <button @click="deleteConversation(confirmDeleteId)" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
