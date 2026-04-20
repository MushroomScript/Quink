<script setup lang="ts">
import { RouterView, useRoute, useRouter } from 'vue-router';
import { computed, onMounted, provide, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { api, type Note } from '@/api';
import Vditor from 'vditor';
import Sidebar from '@/components/Sidebar.vue';
import TopBar from '@/components/TopBar.vue';
import NoteEditModal from '@/components/NoteEditModal.vue';
import GlobalToast from '@/components/GlobalToast.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const showChrome = computed(() => !['login', 'capture', 'float', 'ai-chat'].includes(route.name as string));
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

// 路由变化时自动关闭手机端抽屉
watch(() => route.path, () => { showMobileSidebar.value = false; });

// ── 引用预览 ──
const refPreviewNote = ref<Note | null>(null);
const refPreviewHtml = ref('');
let refPreviewEscHandler: ((e: KeyboardEvent) => void) | null = null;

async function openRefPreview(noteId: string) {
  try {
    const res = await api.getNote(noteId);
    refPreviewNote.value = res.data;
    const processed = res.data.content.replace(
      /\[([\s\S]*?)\]\((\/?[?&]ref=[^)]+)\)/g,
      (_: string, label: string, href: string) => {
        const clean = label.replace(/[\n\r#*`\[\]!>~]/g, ' ').trim().slice(0, 30) || '引用笔记';
        return `<span class="note-ref-link" data-ref="${href}">📌 ${clean}</span>`;
      }
    );
    let html = await Vditor.md2html(processed, { cdn: '/vditor' });
    refPreviewHtml.value = html;

    // Esc 关闭预览(capture phase,比编辑 modal 更早)
    refPreviewEscHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        closeRefPreview();
      }
    };
    document.addEventListener('keydown', refPreviewEscHandler, true);
  } catch (err) {
    console.error('[RefPreview] load failed:', err);
  }
}

function closeRefPreview() {
  refPreviewNote.value = null;
  refPreviewHtml.value = '';
  if (refPreviewEscHandler) {
    document.removeEventListener('keydown', refPreviewEscHandler, true);
    refPreviewEscHandler = null;
  }
}

function extractRefId(el: HTMLElement): string | null {
  const href = el.getAttribute('href') || el.getAttribute('data-ref') || '';
  try {
    return new URL(href, location.origin).searchParams.get('ref');
  } catch { return null; }
}

onMounted(async () => {
  const user = await auth.fetchMe();
  appReady.value = true;
  if (!user) return;
  const prefs = user.preferences || {};

  const theme = prefs.theme || 'blueberry';
  document.documentElement.setAttribute('data-theme', theme);

  const fontSize = prefs.fontSize || 16;
  document.documentElement.style.fontSize = fontSize + 'px';

  // 全局拦截引用链接单击 → 弹预览(不走路由,不打开新标签)
  document.addEventListener('click', (e) => {
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
    <div class="flex h-full overflow-hidden">
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
        <main class="flex-1 overflow-y-auto" style="scrollbar-gutter: stable">
          <RouterView v-slot="{ Component }">
            <KeepAlive :include="['inspiration', 'notes', 'todos']">
              <component :is="Component" />
            </KeepAlive>
          </RouterView>
        </main>
      </div>
    </div>

    <NoteEditModal v-if="editingNote" :note="editingNote" :initial-fullscreen="editFullscreen" @close="closeEditModal" />

    <!-- 引用预览 Modal(z-150 覆盖编辑 modal z-100) -->
    <Teleport to="body">
      <div v-if="refPreviewNote" class="fixed inset-0 z-[150] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30 backdrop-blur-sm" @click="closeRefPreview" />
        <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl mx-4 max-h-[70vh] flex flex-col overflow-hidden ring-1 ring-black/5">
          <div class="flex items-center justify-between px-5 py-3 bg-gray-50/80 shrink-0">
            <div class="flex items-center gap-2">
              <button @click="closeRefPreview" class="p-1 rounded-lg hover:bg-gray-200/60 text-gray-400">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" /></svg>
              </button>
              <span class="text-xs font-medium text-gray-500">引用预览</span>
            </div>
            <button @click="closeRefPreview" class="p-1 rounded-lg hover:bg-gray-200/60 text-gray-400">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
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
