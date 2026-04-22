<script setup lang="ts">
import { RouterView, useRoute, useRouter } from 'vue-router';
import { computed, onMounted, provide, ref, watch, nextTick } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useNotesStore } from '@/stores/notes';
import { api, type Note } from '@/api';
import Vditor from 'vditor';
import { initAudioBubbleHandler } from '@/utils/audio';
import Sidebar from '@/components/Sidebar.vue';
import TopBar from '@/components/TopBar.vue';
import NoteEditModal from '@/components/NoteEditModal.vue';
import GlobalToast from '@/components/GlobalToast.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useNotesStore();

const showChrome = computed(() => !['login', 'capture', 'float', 'ai-chat'].includes(route.name as string));
const isElectron = !!(window as any).quinkDesktop?.isElectron;
const desk = (window as any).quinkDesktop;
const showMobileSidebar = ref(false);
const appReady = ref(false);

const editingNote = ref<Note | null>(null);
const editFullscreen = ref(false);
function openEditModal(note: Note, fullscreen = false) {
  editingNote.value = note;
  editFullscreen.value = fullscreen;
}
function closeEditModal() { editingNote.value = null; editFullscreen.value = false; }
provide('openEditModal', openEditModal);
provide('toggleMobileSidebar', () => { showMobileSidebar.value = !showMobileSidebar.value; });

const hasRefPreviewPending = computed(() => refPreviewStack.value.length > 0 && refPreviewHidden.value);
function restoreRefPreview() {
  refPreviewHidden.value = false;
  router.back();
}
provide('hasRefPreviewPending', hasRefPreviewPending);
provide('restoreRefPreview', restoreRefPreview);

const detailTitle = ref('');
provide('detailTitle', detailTitle);

// 路由变化时自动关闭手机端抽屉
watch(() => route.path, () => { showMobileSidebar.value = false; });

// 保存/恢复 main 滚动位置
const mainEl = ref<HTMLElement>();
const scrollPositions = new Map<string, number>();

router.beforeEach((to, from) => {
  if (mainEl.value && from.path) {
    scrollPositions.set(from.path, mainEl.value.scrollTop);
  }
});

const keepAlivePaths = ['/', '/notes', '/todos'];
let pendingScroll: number | null = null;

router.afterEach((to) => {
  if (keepAlivePaths.includes(to.path)) {
    const saved = scrollPositions.get(to.path);
    if (saved != null) {
      pendingScroll = saved;
      nextTick(() => {
        if (pendingScroll !== null && mainEl.value && !store.loading) {
          mainEl.value.scrollTop = pendingScroll;
          pendingScroll = null;
        }
      });
    }
  } else {
    nextTick(() => { if (mainEl.value) mainEl.value.scrollTop = 0; });
  }
  if (refPreviewHidden.value && !to.path.startsWith('/note/')) {
    refPreviewHidden.value = false;
  }
});

watch(() => store.loading, (loading) => {
  if (!loading && pendingScroll !== null) {
    const pos = pendingScroll;
    pendingScroll = null;
    nextTick(() => { if (mainEl.value) mainEl.value.scrollTop = pos; });
  }
});

// ── 引用预览（栈结构支持多级） ──
const refPreviewStack = ref<{ note: Note; html: string }[]>([]);
const refPreviewHidden = ref(false);
const refPreviewNote = computed(() => refPreviewStack.value.length ? refPreviewStack.value[refPreviewStack.value.length - 1].note : null);
const refPreviewHtml = computed(() => refPreviewStack.value.length ? refPreviewStack.value[refPreviewStack.value.length - 1].html : '');
let refPreviewEscHandler: ((e: KeyboardEvent) => void) | null = null;

async function openRefPreview(noteId: string) {
  try {
    refPreviewHidden.value = false;
    const res = await api.getNote(noteId);
    let md = res.data.content.replace(/^\* \[([ xX])\]/gm, (_, c) => `- [${c.toLowerCase()}]`);
    const processed = md.replace(
      /\[([\s\S]*?)\]\((\/?[?&]ref=[^)]+)\)/g,
      (_: string, label: string, href: string) => {
        const clean = label.replace(/[\n\r#*`\[\]!>~]/g, ' ').trim().slice(0, 30) || '引用笔记';
        return `<span class="note-ref-link" data-ref="${href}">📌 ${clean}</span>`;
      }
    );
    let html = await Vditor.md2html(processed, { cdn: '/vditor' });
    refPreviewStack.value.push({ note: res.data, html });

    if (!refPreviewEscHandler) {
      refPreviewEscHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !refPreviewHidden.value && refPreviewStack.value.length) {
          e.stopImmediatePropagation();
          e.preventDefault();
          goBackRefPreview();
        }
      };
      document.addEventListener('keydown', refPreviewEscHandler, true);
    }
  } catch (err) {
    console.error('[RefPreview] load failed:', err);
  }
}

function goBackRefPreview() {
  if (refPreviewStack.value.length > 1) {
    refPreviewStack.value.pop();
  } else {
    closeRefPreview();
  }
}

function closeRefPreview() {
  refPreviewStack.value = [];
  if (refPreviewEscHandler) {
    document.removeEventListener('keydown', refPreviewEscHandler, true);
    refPreviewEscHandler = null;
  }
}

function goToRefNote() {
  if (!refPreviewNote.value) return;
  const id = refPreviewNote.value.id;
  refPreviewHidden.value = true;
  router.push(`/note/${id}`);
}

function extractRefId(el: HTMLElement): string | null {
  const href = el.getAttribute('href') || el.getAttribute('data-ref') || '';
  try {
    return new URL(href, location.origin).searchParams.get('ref');
  } catch { return null; }
}

onMounted(async () => {
  initAudioBubbleHandler();
  const user = await auth.fetchMe();
  appReady.value = true;
  if (!user) return;
  const prefs = user.preferences || {};

  const theme = prefs.theme || 'blueberry';
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('quink_theme', theme);

  const fontSize = prefs.fontSize || 16;
  document.documentElement.style.fontSize = fontSize + 'px';

  // 全局拦截引用链接单击 → 弹预览(不走路由,不打开新标签)
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest?.('.voice-bubble')) return;
    const el = (e.target as HTMLElement).closest?.('a, .note-ref-link') as HTMLElement | null;
    if (!el) return;
    const refId = extractRefId(el);
    if (refId) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openRefPreview(refId);
    }
  }, true);

  // 拦截 window.open(兜底:Vditor 可能用 window.open 打开链接)
  const origOpen = window.open.bind(window);
  window.open = function(url?: string | URL, target?: string, features?: string) {
    if (url && typeof url === 'string') {
      try {
        const u = new URL(url, location.origin);
        // 音频文件:不打开新窗口
        if (/\.(webm|mp3|wav|ogg|m4a)$/i.test(u.pathname)) return null;
        const refId = u.searchParams.get('ref');
        if (refId) { openRefPreview(refId); return null; }
      } catch {}
    }
    return origOpen(url, target, features);
  } as typeof window.open;
});
</script>

<template>
  <!-- 无 chrome 路由(float / capture / ai-chat / login):直接渲染,跳过全屏 loading -->
  <RouterView v-if="!showChrome" />

  <!-- 主界面 loading -->
  <div v-else-if="!appReady" class="h-full flex items-center justify-center" style="background: var(--c-body, #f5f5f7)">
    <div class="text-center">
      <h1 class="text-2xl font-bold" style="color: rgb(var(--c-accent, 116 143 252))">Quink</h1>
      <p class="text-xs text-gray-400 mt-1">加载中...</p>
    </div>
  </div>

  <!-- 主界面 -->
  <template v-else>
    <div class="flex flex-col h-full overflow-hidden">
      <!-- 自定义标题栏(仅 Electron) -->
      <div v-if="isElectron" class="flex items-center justify-between h-9 px-4 shrink-0"
        style="-webkit-app-region: drag; background: rgb(var(--c-sidebar))">
        <span class="text-xs font-semibold" style="color: var(--sb-text)">Quink - 一念</span>
        <div class="flex items-center" style="-webkit-app-region: no-drag">
          <button @click="desk?.minimize()" class="w-10 h-9 flex items-center justify-center hover:bg-black/10 transition-colors" style="color: var(--sb-dim)">
            <svg width="12" height="1" viewBox="0 0 12 1"><rect width="12" height="1" fill="currentColor"/></svg>
          </button>
          <button @click="desk?.maximize()" class="w-10 h-9 flex items-center justify-center hover:bg-black/10 transition-colors" style="color: var(--sb-dim)">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="0.5" y="0.5" width="9" height="9" rx="1"/></svg>
          </button>
          <button @click="desk?.close()" class="w-10 h-9 flex items-center justify-center hover:bg-red-500 hover:text-white transition-colors" style="color: var(--sb-dim)">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg>
          </button>
        </div>
      </div>

      <div class="flex flex-1 overflow-hidden">
        <div class="hidden md:block">
          <Sidebar />
        </div>

      <!-- Mobile sidebar drawer -->
      <div v-if="showMobileSidebar" class="fixed inset-0 z-50 md:hidden">
        <div class="absolute inset-0 bg-black/40" @click="showMobileSidebar = false" />
        <div class="absolute left-0 -top-[200px] -bottom-[200px] w-60 shadow-2xl overflow-y-auto bg-sidebar pt-[200px] pb-[200px]" @click.stop>
          <Sidebar />
        </div>
      </div>

      <div class="flex-1 flex flex-col overflow-hidden">
        <TopBar />
        <main ref="mainEl" class="flex-1 overflow-y-auto" style="scrollbar-gutter: stable">
          <RouterView v-slot="{ Component }">
            <KeepAlive :include="['inspiration', 'notes', 'todos']">
              <component :is="Component" />
            </KeepAlive>
          </RouterView>
        </main>
      </div>
      </div>
    </div>

    <NoteEditModal v-if="editingNote" :note="editingNote" :initial-fullscreen="editFullscreen" @close="closeEditModal" />

    <!-- 引用预览 Modal(z-150 覆盖编辑 modal z-100) -->
    <Teleport to="body">
      <div v-if="refPreviewNote && !refPreviewHidden" class="fixed inset-0 z-[150] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30 backdrop-blur-sm" @click="goBackRefPreview" />
        <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl mx-4 max-h-[70vh] flex flex-col overflow-hidden ring-1 ring-black/5">
          <div class="flex items-center justify-between px-5 py-3 bg-gray-50/80 shrink-0">
            <div class="flex items-center gap-2">
              <button @click="goBackRefPreview" class="p-1 rounded-lg hover:bg-gray-200/60 text-gray-400">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" /></svg>
              </button>
              <span class="text-xs font-medium text-gray-500">引用预览{{ refPreviewStack.length > 1 ? ` (${refPreviewStack.length})` : '' }}</span>
            </div>
            <div class="flex items-center gap-1">
              <button @click="goToRefNote()" class="px-2 py-1 rounded-lg text-[11px] hover:bg-gray-200/60 transition-colors" style="color: rgb(var(--c-accent-dark))">
                查看详情
              </button>
              <button @click="closeRefPreview" class="p-1 rounded-lg hover:bg-gray-200/60 text-gray-400">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
          </div>
          <div class="flex-1 overflow-y-auto px-6 py-4">
            <div v-if="refPreviewNote.summary" class="text-sm text-gray-500 italic mb-3">{{ refPreviewNote.summary }}</div>
            <div class="prose prose-sm max-w-none note-content" v-html="refPreviewHtml" />
            <div v-if="refPreviewNote.tags?.length" class="flex flex-wrap gap-1.5 mt-4 pt-3 border-t border-gray-100">
              <span v-for="tag in refPreviewNote.tags" :key="tag" class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">#{{ tag }}</span>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </template>

  <!-- 全局 Toast -->
  <GlobalToast />
</template>
