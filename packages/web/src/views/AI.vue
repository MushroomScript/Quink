<script setup lang="ts">
defineOptions({ name: 'ai-page' });
import { ref, onMounted, onActivated, onDeactivated, nextTick, watch } from 'vue';
import { api } from '@/api';
import Vditor from 'vditor';
import { useRouter, useRoute } from 'vue-router';
import { resolveMarkdownFileUrls } from '@/utils/fileUrl';
import { useEscToClose } from '@/composables/useEscToClose';
import { dragState } from '@/utils/cardDnd';
import {
  PhXCircle,
  PhList,
  PhCaretUp,
  PhCaretDown,
  PhPencilSimple,
  PhCircleNotch,
  PhArrowsClockwise,
  PhStop,
  PhPaperPlaneTilt,
  PhSparkle,
  PhPaperclip,
} from '@phosphor-icons/vue';

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
// 流式期间增量渲染的 HTML，避免输出过程中只显示 ### 等 markdown 原文
const streamingHtmlMap = ref(new Map<string, string>());
// 版本号：每个 delta 自增，md2html 完成后只有"比上次成功渲染的版本新"才覆盖 HTML，
// 保证内容单调向前，又允许多个 in-flight md2html 都有机会更新
const streamingVersion = new Map<string, number>();
const streamingLastRenderVer = new Map<string, number>();
const confirmDeleteId = ref('');
useEscToClose(confirmDeleteId, '');
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
const convFindState = new Map<string, { show: boolean; query: string; current: number }>();

function saveConvState() {
  const id = currentConvId.value;
  if (!id) return;
  convDrafts.set(id, query.value);
  convFindState.set(id, { show: showFindBar.value, query: findQuery.value, current: findCurrent.value });
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
    if (fs.show && fs.query) {
      const savedCurrent = fs.current;
      nextTick(() => { doFind(); findCurrent.value = savedCurrent; scrollToFindMatch(false); });
    }
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
const sourceNotes = ref<Record<string, { id: string; summary: string; content: string; type: string }[]>>({});
const SOURCE_TYPE_LABELS: Record<string, string> = { note: '灵感', todo: '待办', snippet: '笔记', link: '链接' };
const SOURCE_TYPE_COLORS: Record<string, string> = {
  note: 'bg-primary-light text-primary-dark',
  todo: 'bg-amber-100 text-amber-600',
  snippet: 'bg-emerald-100 text-emerald-600',
  link: 'bg-sky-100 text-sky-600',
};
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
  window.addEventListener('quink-ai-drop', onAiDropEvent);
  document.addEventListener('keydown', onGlobalKeydown);
  // 兜底: drop 在 AI 还没 mount 时派的事件 listener 没挂上, 走 sessionStorage 中转
  const pendingRaw = sessionStorage.getItem('quink_ai_pending_drop');
  if (pendingRaw) {
    sessionStorage.removeItem('quink_ai_pending_drop');
    try { await handleAiDrop(JSON.parse(pendingRaw)); } catch {}
  }
});

onDeactivated(() => {
  saveConvState();
  if (messagesEl.value) messagesEl.value.style.visibility = 'hidden';
});

onActivated(async () => {
  requestAnimationFrame(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = savedScroll;
      messagesEl.value.style.visibility = '';
    }
  });
  // keep-alive 复用时 onMounted 不再触发, 这里也兜一道 pending drop
  const pendingRaw = sessionStorage.getItem('quink_ai_pending_drop');
  if (pendingRaw) {
    sessionStorage.removeItem('quink_ai_pending_drop');
    try { await handleAiDrop(JSON.parse(pendingRaw)); } catch {}
  }
});

async function loadConversations() {
  try {
    const res = await api.getConversations();
    conversations.value = res.data;
  } catch {}
}

function newConversation() {
  saveConvState();
  clearHighlights();
  currentConvId.value = '';
  messages.value = [];
  query.value = '';
  showFindBar.value = false;
  findQuery.value = '';
  sessionStorage.removeItem('quink_ai_conv');
  router.replace({ query: {} });
}

// 卡片拖到 AI 各分支统一处理: 拼简洁的引用链接塞 query (多条换行分隔, 用户视觉简洁);
// new: 新对话 (但如果当前已有打开的对话, 不开新, 走 current); conv: 切到指定 conv; current: 当前对话不动只填输入框
async function handleAiDrop(payload: { kind: 'new' | 'conv' | 'current'; ids: string[]; convId?: string }) {
  const refs: string[] = [];
  for (const id of payload.ids) {
    try {
      const res = await api.getNote(id);
      const n = res.data;
      const label = (n.summary || n.content?.slice(0, 30) || '笔记').replace(/[\[\]]/g, '').replace(/\n+/g, ' ');
      refs.push(`[${label}](?ref=${id})`);
    } catch {}
  }
  const text = refs.join('\n');
  if (!text) return;
  // kind='new' 但当前已经有打开的对话 (用户在 /ai 内拖到 sidebar AI 项) → 走 current, 别开新对话
  const effectiveKind = payload.kind === 'new' && currentConvId.value ? 'current' : payload.kind;
  if (effectiveKind === 'conv' && payload.convId) {
    if (currentConvId.value !== payload.convId) await selectConversation(payload.convId);
    await nextTick();
  } else if (effectiveKind === 'new') {
    newConversation();
    await nextTick();
  }
  query.value = query.value ? (query.value + '\n' + text) : text;
  // textarea v-model 赋值不触发 @input → 手动调一次 autoGrow 撑高
  await nextTick();
  autoGrowTextarea();
  queryEl.value?.focus();
}

function onAiDropEvent(e: Event) {
  // 同时清 sessionStorage 中转, 避免 onActivated 切回时又读 + 重复 handleAiDrop 追加
  sessionStorage.removeItem('quink_ai_pending_drop');
  const payload = (e as CustomEvent).detail;
  if (payload) handleAiDrop(payload);
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
        try { html = await Vditor.md2html(resolveMarkdownFileUrls(renderContent), { cdn: '/vditor' } as any); } catch {}
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
  // 延迟创建：第一次发消息时才在后端建对话
  if (!currentConvId.value) {
    try {
      const res = await api.createConversation();
      currentConvId.value = res.data.id;
      conversations.value.unshift(res.data);
      sessionStorage.setItem('quink_ai_conv', res.data.id);
      router.replace({ query: { conv: res.data.id } });
    } catch { return; }
  }
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
            // 每个 delta 都立即触发 md → html 渲染（流式打字机效果）。
            // 完成时只要 myVer > 上次成功渲染的 ver 就覆盖：保证内容单调向新，又不会被旧 in-flight 抢占。
            const myVer = (streamingVersion.get(targetConvId) || 0) + 1;
            streamingVersion.set(targetConvId, myVer);
            const snapshot = fullContent;
            (async () => {
              const { answer } = parseThinking(snapshot);
              const content = stripOuterCodeFence(answer || snapshot);
              try {
                const h = await Vditor.md2html(resolveMarkdownFileUrls(content), { cdn: '/vditor' } as any);
                if (myVer > (streamingLastRenderVer.get(targetConvId) || 0) && streamingMap.value.has(targetConvId)) {
                  streamingLastRenderVer.set(targetConvId, myVer);
                  streamingHtmlMap.value.set(targetConvId, h);
                }
              } catch {}
            })();
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
    try { html = await Vditor.md2html(resolveMarkdownFileUrls(renderText), { cdn: '/vditor' } as any); } catch {}
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
    streamingHtmlMap.value.delete(targetConvId);
    streamingVersion.delete(targetConvId);
    streamingLastRenderVer.delete(targetConvId);
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
  if (!text) return;
  const idx = messages.value.findIndex(m => m.id === msg.id);
  if (idx >= 0) {
    // 后端删除该消息及之后的
    if (currentConvId.value && msg.id && !msg.id.startsWith('temp-')) {
      try { await api.deleteMessagesFrom(currentConvId.value, msg.id); } catch {}
    }
    messages.value.splice(idx);
  }
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
    const notes: { id: string; summary: string; content: string; type: string }[] = [];
    for (const nid of noteIds) {
      try {
        const res = await api.getNote(nid);
        notes.push({ id: nid, summary: res.data.summary || '', content: res.data.content.slice(0, 100), type: res.data.type });
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

function scrollToFindMatch(smooth = true) {
  if (!messagesEl.value) return;
  const marks = messagesEl.value.querySelectorAll('mark.find-hl');
  marks.forEach(m => m.classList.remove('find-hl-active'));
  const target = marks[findCurrent.value - 1];
  if (target) {
    target.classList.add('find-hl-active');
    target.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'instant' });
  }
}

const currentConv = ref<Conversation | null>(null);
watch(currentConvId, (id) => { currentConv.value = conversations.value.find(c => c.id === id) || null; });

const lastMsgNeedsRetry = ref(false);
watch(messages, (msgs) => {
  lastMsgNeedsRetry.value = msgs.length > 0 && msgs[msgs.length - 1].role === 'user' && !loadingConvs.value.has(currentConvId.value);
}, { deep: true });

async function retryLastMessage() {
  const last = messages.value[messages.value.length - 1];
  if (!last || last.role !== 'user') return;
  // 删掉这条用户消息，重新发送
  const text = last.content;
  if (currentConvId.value && last.id && !last.id.startsWith('temp-')) {
    try { await api.deleteMessagesFrom(currentConvId.value, last.id); } catch {}
  }
  messages.value.pop();
  query.value = text;
  await sendMessage();
}
</script>

<template>
  <!-- absolute inset-0: 占满 main 的 viewport (main relative), 不依赖 portal 高度.
       原因: App.vue main 内的 #batch-bar-portal 是 content-based 高度 (sticky batch bar 范围必须 = 内容全高),
       AI.vue 之前用 h-full 拿不到 portal 高度 (portal 自身 content-based 跟 children 循环依赖) → 退化为 content height,
       AI.vue 内双栏 flex-col 撑大 main → main 整体滚动 → 双栏不再独立滚动.
       absolute 脱离 portal 文档流, AI 页面下 portal height = 0 不影响 (本就不需要 main 滚动), 切换到瀑布流页面恢复正常.
       sticky batch bar 在 AI 页面不出现, 这里不需要考虑 portal sticky range. -->
  <div class="absolute inset-0 flex overflow-hidden">
    <!-- 左侧：对话列表（桌面端） -->
    <div class="w-56 shrink-0 border-r border-gray-100 flex flex-col bg-gray-50/50 hidden md:flex">
      <div class="p-3 space-y-2">
        <button @click="newConversation" class="w-full px-3 py-2 text-xs font-medium rounded-lg transition-colors text-white" style="background: rgb(var(--c-accent))">
          + 新对话
        </button>
        <div class="relative">
          <input v-model="searchConv" @input="onSearchInput" placeholder="搜索对话..." class="w-full px-2.5 py-1.5 pr-7 bg-white border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-primary/20 placeholder-gray-400" />
          <button v-if="searchConv" @click="clearSearchConv" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            <PhXCircle size="0.875rem" weight="fill" />
          </button>
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        <TransitionGroup name="conv-list" tag="div" class="space-y-0.5">
          <div v-for="conv in filteredConversations" :key="conv.id"
            @click="selectConversation(conv.id)"
            :data-drop-target="'conv:' + conv.id"
            class="group flex items-center gap-1 px-3 py-2 rounded-lg cursor-pointer text-xs transition-colors"
            :class="[
              currentConvId === conv.id ? 'bg-white shadow-sm font-medium text-gray-800' : 'text-gray-500 hover:bg-white/60',
              dragState.active && dragState.hoverTarget === 'conv:' + conv.id ? 'drop-target-active' : ''
            ]">
            <div class="flex-1 min-w-0">
              <div v-if="editingConvId === conv.id" class="flex">
                <input v-model="editingTitle" @blur="saveTitle" @keydown.enter="saveTitle" class="w-full px-1 py-0.5 border border-gray-200 rounded text-xs outline-none" autofocus @click.stop />
              </div>
              <div v-else @dblclick.stop="startEditTitle(conv)" class="truncate">{{ conv.title }}</div>
              <div class="text-[10px] text-gray-400 mt-0.5">{{ conv.updatedAt?.slice(5, 16).replace('T', ' ') }}</div>
            </div>
            <button @click.stop="askDeleteConv(conv.id)" class="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-400 shrink-0 transition-opacity">
              <PhXCircle size="0.875rem" weight="fill" />
            </button>
          </div>
        </TransitionGroup>
        <div v-if="filteredConversations.length === 0" class="text-center py-8 text-xs text-gray-400">{{ searchConv ? '无匹配' : '暂无对话' }}</div>
      </div>
    </div>

    <!-- 手机端对话列表抽屉 -->
    <div v-if="showMobileConvs" class="fixed inset-0 z-[var(--z-sidebar)] md:hidden">
      <div class="absolute inset-0 bg-black/40" @click="showMobileConvs = false" />
      <div class="absolute left-0 top-0 bottom-0 w-64 bg-white shadow-2xl flex flex-col" @click.stop>
        <div class="p-3 space-y-2">
          <button @click="newConversation" class="w-full px-3 py-2 text-xs font-medium rounded-lg text-white" style="background: rgb(var(--c-accent))">+ 新对话</button>
          <div class="relative">
            <input v-model="searchConv" @input="onSearchInput" placeholder="搜索对话..." class="w-full px-2.5 py-1.5 pr-7 bg-gray-50 border border-gray-200 rounded-lg text-xs outline-none placeholder-gray-400" />
            <button v-if="searchConv" @click="clearSearchConv" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <PhXCircle size="0.875rem" weight="fill" />
            </button>
          </div>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          <TransitionGroup name="conv-list" tag="div" class="space-y-0.5">
            <div v-for="conv in filteredConversations" :key="conv.id"
              @click="selectConversation(conv.id)"
              class="flex items-center gap-1 px-3 py-2.5 rounded-lg cursor-pointer text-xs"
              :class="currentConvId === conv.id ? 'bg-primary-light font-medium text-primary-dark' : 'text-gray-600'">
              <div class="flex-1 min-w-0 truncate">{{ conv.title }}</div>
              <button @click.stop="askDeleteConv(conv.id)" class="p-0.5 text-gray-400 shrink-0">
                <PhXCircle size="0.875rem" weight="fill" />
              </button>
            </div>
          </TransitionGroup>
        </div>
      </div>
    </div>

    <!-- 右侧：消息区 -->
    <div class="flex-1 flex flex-col min-w-0">
      <!-- 手机端顶部：对话列表按钮 -->
      <div class="md:hidden flex items-center gap-2 px-3 py-2 border-b border-gray-100">
        <button @click="showMobileConvs = true" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
          <PhList size="1.25rem" weight="fill" />
        </button>
        <span class="text-xs text-gray-500 truncate">{{ currentConv?.title || 'AI 对话' }}</span>
      </div>
      <!-- Ctrl+F 查找栏 -->
      <div v-if="showFindBar" class="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 bg-gray-50/80">
        <input v-model="findQuery" @input="doFind" @keydown.enter.prevent="findNext" @keydown.escape="closeFindBar"
          class="ai-find-input flex-1 px-2.5 py-1 bg-white border border-gray-200 rounded text-xs outline-none focus:ring-2 focus:ring-primary/20" placeholder="在对话中查找..." />
        <span v-if="findQuery" class="text-[10px] text-gray-400 shrink-0">{{ findCurrent }}/{{ findMatches }}</span>
        <button @click="findPrev" class="p-1 text-gray-400 hover:text-gray-600" title="上一个">
          <PhCaretUp size="0.875rem" weight="fill" />
        </button>
        <button @click="findNext" class="p-1 text-gray-400 hover:text-gray-600" title="下一个">
          <PhCaretDown size="0.875rem" weight="fill" />
        </button>
        <button @click="closeFindBar" class="p-1 text-gray-400 hover:text-gray-600">
          <PhXCircle size="0.875rem" weight="fill" />
        </button>
      </div>
      <div ref="messagesEl" data-drop-target="ai-page" class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-6 space-y-4">
        <!-- 空状态 -->
        <div v-if="!currentConvId || messages.length === 0" class="text-center py-16">
          <div class="mb-3 flex justify-center text-gray-300">
            <PhSparkle size="3rem" weight="fill" />
          </div>
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
                <PhPencilSimple size="0.875rem" weight="fill" />
              </button>
            </div>
            <!-- AI 消息 -->
            <div v-else class="px-4 py-3 rounded-2xl rounded-bl-md text-sm bg-white border border-gray-100 text-gray-700 shadow-sm">
              <!-- 思考模型：折叠的思考过程 -->
              <details v-if="msg.role === 'assistant' && parseThinking(msg.content).thinking" class="mb-2">
                <summary class="text-xs text-gray-400 cursor-pointer hover:text-gray-500 select-none">查看思考过程</summary>
                <div class="mt-1 px-3 py-2 bg-gray-50 rounded-lg text-xs text-gray-400 italic whitespace-pre-wrap max-h-40 overflow-y-auto">{{ parseThinking(msg.content).thinking }}</div>
              </details>
              <div v-if="msg.html" class="note-content">
                <div class="vditor-reset" v-html="msg.thinkingHtml || msg.html" />
              </div>
              <template v-else>{{ parseThinking(msg.content).answer || msg.content }}</template>
            </div>
            <!-- 来源标注 -->
            <div v-if="msg.role === 'assistant' && msg.sources?.length" class="mt-1.5 ml-1">
              <button @click="toggleSources(msg.id, msg.sources)" class="text-[11px] text-gray-400 hover:text-gray-600 transition-colors inline-flex items-center gap-1">
                <PhPaperclip size="0.75rem" weight="fill" />
                <span>参考了 {{ msg.sources.length }} 项</span>
                <PhCaretUp v-if="showSources[msg.id]" size="0.625rem" weight="fill" />
                <PhCaretDown v-else size="0.625rem" weight="fill" />
              </button>
              <div v-show="showSources[msg.id] && sourceNotes[msg.id]" class="mt-1 space-y-1 max-h-60 overflow-y-auto">
                <div v-for="note in sourceNotes[msg.id]" :key="note.id"
                  @click="goToNote(note.id)"
                  class="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg text-xs text-gray-500 cursor-pointer hover:bg-gray-100 transition-colors">
                  <span class="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0" :class="SOURCE_TYPE_COLORS[note.type] || 'bg-gray-200 text-gray-600'">
                    {{ SOURCE_TYPE_LABELS[note.type] || note.type }}
                  </span>
                  <span class="truncate">{{ note.summary || note.content }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 工具调用状态 -->
        <div v-if="toolCallStatus.get(currentConvId)" class="flex justify-start">
          <div class="bg-white border border-gray-100 text-gray-400 px-4 py-3 rounded-2xl rounded-bl-md text-sm shadow-sm flex items-center gap-2">
            <PhCircleNotch size="0.875rem" weight="fill" class="animate-spin" />
            正在{{ toolCallStatus.get(currentConvId) }}...
          </div>
        </div>

        <!-- 流式输出中（含思考模型解析） -->
        <div v-if="streamingMap.get(currentConvId)" class="flex justify-start">
          <div class="max-w-[80%] px-4 py-3 bg-white border border-gray-100 text-gray-700 rounded-2xl rounded-bl-md shadow-sm text-sm">
            <!-- 思考过程 -->
            <div v-if="parseThinking(streamingMap.get(currentConvId) || '').thinking" class="mb-2 px-3 py-2 bg-gray-50 rounded-lg text-xs text-gray-400 italic">
              <div class="font-medium text-gray-500 mb-1 flex items-center gap-1">
                <PhCircleNotch size="0.75rem" weight="fill" class="animate-spin" />
                思考中...
              </div>
              <div class="whitespace-pre-wrap max-h-32 overflow-y-auto">{{ parseThinking(streamingMap.get(currentConvId) || '').thinking }}</div>
            </div>
            <!-- 正式回答：v-html 增量渲染 markdown，首 60ms 内 fallback 纯文本 -->
            <template v-if="parseThinking(streamingMap.get(currentConvId) || '').answer || !parseThinking(streamingMap.get(currentConvId) || '').thinking">
              <div v-if="streamingHtmlMap.get(currentConvId)" class="note-content">
                <div class="vditor-reset" v-html="streamingHtmlMap.get(currentConvId)" />
              </div>
              <div v-else class="note-content">
                <div class="vditor-reset whitespace-pre-wrap">{{ parseThinking(streamingMap.get(currentConvId) || '').answer || streamingMap.get(currentConvId) }}</div>
              </div>
              <span class="animate-pulse">▊</span>
            </template>
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
            思考中...
          </div>
        </div>

        <!-- 重试按钮（最后一条是用户消息，AI 没回复） -->
        <div v-if="lastMsgNeedsRetry" class="flex justify-center py-2">
          <button @click="retryLastMessage" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 flex items-center gap-1.5 transition-colors">
            <PhArrowsClockwise size="0.875rem" weight="fill" />
            重新生成
          </button>
        </div>
      </div>

      <!-- 输入框 (data-drop-target 让拖到输入框松开也走 'ai-page' 分支 = 塞到当前对话输入框) -->
      <!-- shrink-0: flex 父容器空间不足时也不被挤压, 跟 messagesEl 的 min-h-0 配对防"展开引用列表把输入框顶出 viewport" -->
      <div class="px-4 md:px-6 py-3 border-t border-gray-100 shrink-0" data-drop-target="ai-page">
        <div class="flex gap-2 items-end">
          <div class="flex-1 min-w-0 bg-white border border-gray-200 rounded-xl overflow-hidden focus-within:border-primary transition-colors pt-1.5">
            <textarea ref="queryEl" v-model="query" @keydown="handleKeydown" @input="autoGrowTextarea" placeholder="问点什么..." rows="1"
              class="w-full px-4 pt-1.5 pb-2.5 border-0 text-sm outline-none resize-none"
              style="max-height: 33vh; overflow: hidden; background: transparent !important" />
          </div>
          <button v-if="loadingConvs.has(currentConvId)" @click="stopGeneration"
            class="p-2.5 rounded-xl border border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-500 hover:border-red-200 transition-colors shrink-0" title="停止生成">
            <PhStop size="1rem" weight="fill" />
          </button>
          <button v-else @click="sendMessage" :disabled="!query.trim()"
            class="p-2.5 rounded-xl text-white disabled:opacity-40 transition-colors shrink-0"
            style="background: rgb(var(--c-accent))" title="发送">
            <PhPaperPlaneTilt size="1rem" weight="fill" />
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 删除确认弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmDeleteId" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
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
    </Transition>
  </Teleport>
</template>

<style>
/* 对话列表项删除时左滑飞走 + 高度收缩，相邻项自然上移 */
.conv-list-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}
.conv-list-leave-to {
  opacity: 0;
  transform: translateX(-110%);
  max-height: 0 !important;
  margin-top: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}
.conv-list-leave-from {
  max-height: 5rem;
}
</style>
