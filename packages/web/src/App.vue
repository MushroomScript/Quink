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
import { PhMinus, PhSquare, PhX, PhXCircle, PhCaretLeft } from '@phosphor-icons/vue';
import { REF_LINK_REGEX, renderRefLink, injectRefLinkIcons } from '@/utils/refLink';
import { resolveMarkdownFileUrls, injectMissingFileFallback } from '@/utils/fileUrl';
import { useTheme } from '@/composables/useTheme';
import { useToast } from '@/composables/useToast';
import { useImagePreview } from '@/composables/useImagePreview';
import ImagePreview from '@/components/ImagePreview.vue';
import MediaContextMenu from '@/components/MediaContextMenu.vue';
import DragGhost from '@/components/DragGhost.vue';
import AttachmentDownloadDock from '@/components/AttachmentDownloadDock.vue';
import { addTask as addAttachmentTask, updateProgress as updateAttachmentProgress, markSuccess as markAttachmentSuccess, markFailed as markAttachmentFailed, markCancelled as markAttachmentCancelled } from '@/composables/useAttachmentTasks';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useNotesStore();

const showChrome = computed(() => !['login', 'capture', 'float', 'ai-chat'].includes(route.name as string));
const isElectron = !!(window as any).quinkDesktop?.isElectron;
const desk = (window as any).quinkDesktop;
const showMobileSidebar = ref(false);
const appReady = ref(false);
const currentTheme = useTheme();
const { show: showToast } = useToast();

// 附件下载: 进度走悬浮 dock(AttachmentDownloadDock + useAttachmentTasks), 仅在最终 success/failed 弹 toast.
// 不再用单条 toast 滚动文案的旧方案(每 100ms 推一次会堆叠 N 条).
desk?.onAttachmentProgress?.((data: { url: string; received: number; total: number }) => {
  updateAttachmentProgress(data.url, data.received, data.total);
});
// renderer 端记录"已成功打开过的 URL", 二次点击跳过 dock 直接 toast.
// 跟 main 端的 attachmentCache 同生命周期(重启都清), 一致性自然保证.
const openedAttachments = new Set<string>();

// 主题切换时同步换 favicon（含 .ico 和 .png 两条 link）
watch(currentTheme, (t) => {
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
  links.forEach((link) => {
    if (link.type === 'image/png') link.href = `/quink-${t}-192.png`;
    else link.href = `/favicon-${t}.ico`;
  });
}, { immediate: true });

// 编辑模态: 列表三点菜单 / 详情页编辑按钮 / 引用预览编辑 都走这个统一入口
// fullscreen 偏好持久化到 localStorage(由 RichEditor 的 toggleFullscreen 写入),
// 下次打开默认沿用上次状态。调用方不传 fullscreen 参数就走 localStorage 偏好。
const editingNote = ref<Note | null>(null);
const editFullscreen = ref(false);
function openEditModal(note: Note, fullscreen?: boolean) {
  editingNote.value = note;
  if (fullscreen !== undefined) {
    editFullscreen.value = fullscreen;
  } else {
    editFullscreen.value = localStorage.getItem('quink_edit_fullscreen') === '1';
  }
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

const keepAlivePaths = ['/', '/notes', '/todos', '/ai'];
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
    const processed = md.replace(REF_LINK_REGEX, (_, label, href) => renderRefLink(label, href, 30));
    const withFiles = resolveMarkdownFileUrls(processed);  // 文件链接裸名拼前缀
    let html = await Vditor.md2html(withFiles, { cdn: '/vditor' } as any);
    html = injectRefLinkIcons(html);
    html = injectMissingFileFallback(html);
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

function applyUserPreferences(user: any) {
  if (!user) return;
  const prefs = user.preferences || {};
  // 服务端可能返回不完整 preferences（慢启动 / 数据迁移等边缘 case），
  // hard fallback 'blueberry' / 16 会覆盖 localStorage 里的正确值 → 用户感受"变默认"。
  // 只在拿到明确值时才覆盖，缺失时保留 inline script 已经应用的本地缓存值。
  if (prefs.theme) {
    document.documentElement.setAttribute('data-theme', prefs.theme);
    localStorage.setItem('quink_theme', prefs.theme);
  }
  if (prefs.fontSize) {
    document.documentElement.style.fontSize = prefs.fontSize + 'px';
    localStorage.setItem('quink_font_size', String(prefs.fontSize));
  }
}

// HMR 友好：模块级保存上次挂的副作用，重 mount 时先清理旧的，避免 capture 阶段旧 handler
// 抢先 stopImmediatePropagation 调用旧闭包里的 openRefPreview（操作旧响应式状态，新 UI 看不到预览）。
let prevRefClickHandler: ((e: MouseEvent) => void) | null = null;
let prevImgClickHandler: ((e: MouseEvent) => void) | null = null;
let prevCopyHandler: ((e: ClipboardEvent) => void) | null = null;
let prevCtrlAHandler: ((e: KeyboardEvent) => void) | null = null;
let prevWindowOpen: typeof window.open | null = null;

const { open: openImagePreview } = useImagePreview();

onMounted(async () => {
  initAudioBubbleHandler();
  const user = await auth.fetchMe();
  appReady.value = true;
  if (!user) return;
  applyUserPreferences(user);

  // 清理 HMR 残留
  if (prevRefClickHandler) document.removeEventListener('click', prevRefClickHandler, true);
  if (prevImgClickHandler) document.removeEventListener('click', prevImgClickHandler, true);
  if (prevCopyHandler) document.removeEventListener('copy', prevCopyHandler);
  if (prevCtrlAHandler) document.removeEventListener('keydown', prevCtrlAHandler, true);
  if (prevWindowOpen) window.open = prevWindowOpen;

  // 全局拦截 note-content 内 img 单击 → 弹图片预览(同一笔记的所有图作为一组,可左右切换)
  // 必须 capture + stopPropagation:否则 NoteCard 的 click handler 也会收到,误触发"进入详情"
  const imgHandler = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== 'IMG') return;
    const container = target.closest('.note-content');
    if (!container) return;
    const img = target as HTMLImageElement;
    e.preventDefault();
    e.stopPropagation();
    const allImgs = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
    const idx = allImgs.indexOf(img);
    const images = allImgs.map(i => ({
      url: i.src,
      filename: i.alt || (i.src.split('/').pop() || 'image').split('?')[0],
    }));
    openImagePreview(images, idx);
  };
  document.addEventListener('click', imgHandler, true);
  prevImgClickHandler = imgHandler;

  // 全局拦截引用链接单击 → 弹预览(不走路由,不打开新标签)
  // 同时拦截 /api/uploads/* 附件链接 → 桌面端调系统默认应用打开,web 端走浏览器下载。
  // 否则浏览器跟随 a.href 跳走,Electron 内嵌 chromium 对 text/markdown 等 mime 显示空白页。
  const handler = async (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest?.('.voice-bubble')) return;
    const el = (e.target as HTMLElement).closest?.('a, .note-ref-link') as HTMLElement | null;
    if (!el) return;
    const refId = extractRefId(el);
    if (refId) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openRefPreview(refId);
      return;
    }
    // 附件链接: 图片/音频已有专门处理(imgHandler / voice-bubble),这里只接其他文件类型
    const href = el.getAttribute('href') || '';
    if (href.includes('/api/uploads/') && !/\.(png|jpg|jpeg|gif|webp|svg|webm|mp3|wav|ogg|m4a)$/i.test(href)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const fullUrl = new URL(href, location.origin).toString();
      const filename = decodeURIComponent(href.split('/').pop() || '附件');
      if (desk?.openAttachment) {
        // renderer 端 cache: 之前成功打开过这个 URL → 跳过 dock 直接 invoke + toast.
        // 跟 main 端 attachmentCache 同生命周期(都是进程内 Map, 重启都清), 不会出现 renderer 觉得
        // 有 cache 但 main 那边却没 cache 的情况
        if (openedAttachments.has(fullUrl)) {
          const result = await desk.openAttachment(fullUrl);
          if (result?.success) {
            showToast(`已打开 ${filename}`, 'success', 1500);
          } else {
            showToast(`打开失败: ${result?.error || '未知错误'}`, 'error', 3000);
          }
          return;
        }
        // 第一次打开: 走 dock 全流程
        addAttachmentTask(fullUrl, filename);
        const result = await desk.openAttachment(fullUrl);
        if (result?.success) {
          markAttachmentSuccess(fullUrl);
          openedAttachments.add(fullUrl);
          showToast(`已打开 ${filename}`, 'success', 1500);
        } else if (result?.cancelled) {
          markAttachmentCancelled(fullUrl);
        } else {
          markAttachmentFailed(fullUrl, result?.error || '未知错误');
          showToast(`打开失败: ${result?.error || '未知错误'}`, 'error', 3000);
        }
      } else {
        // Web 端 fallback: 用 a.download 触发浏览器原生下载
        const link = document.createElement('a');
        link.href = href;
        link.download = '';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    }
  };
  document.addEventListener('click', handler, true);
  prevRefClickHandler = handler;

  // 跨多 NoteCard 复制时整理剪贴板: 浏览器默认拼接 textContent 会让"类型 分类 时间 内容 #tag"
  // 全部挤一坨,粘出来乱. 这里检测 selection 是否跨多个卡片,跨多个时自定义 clipboard:
  // 每张卡片 = [类型 · 分类 · 时间] + 正文 + tags, 中间用 --- 分隔
  const copyHandler = (e: ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    // 收集 selection 跨过的所有 NoteCard
    const cards = document.querySelectorAll('.notes-masonry .masonry-col > div');
    const touched: Element[] = [];
    for (const card of cards) {
      if (sel.containsNode(card, true)) touched.push(card);
    }
    if (touched.length < 2) return; // 单卡片 / 不在列表 → 浏览器默认行为
    const blocks = touched.map(card => {
      // type 标签自己也带 .text-[11px] class,跟时间区分:type 是 .rounded-full, 时间是 .ml-auto
      const type = card.querySelector('.flex.items-center.gap-2 > .rounded-full')?.textContent?.trim() || '';
      const category = card.querySelector('.flex.items-center.gap-2 > .text-xs:not(.rounded-full)')?.textContent?.trim() || '';
      const time = card.querySelector('.flex.items-center.gap-2 > .ml-auto')?.textContent?.trim() || '';
      const headerLine = [type, category, time].filter(Boolean).join(' · ');
      const summary = card.querySelector('p.italic')?.textContent?.trim() || '';
      const content = card.querySelector('.note-content')?.textContent?.trim() || '';
      const tags = [...card.querySelectorAll('.flex.flex-wrap > span')].map(s => s.textContent?.trim()).filter(Boolean).join(' ');
      const parts = [headerLine, summary, content, tags].filter(Boolean);
      return parts.join('\n');
    });
    e.preventDefault();
    e.clipboardData?.setData('text/plain', blocks.join('\n\n---\n\n'));
  };
  document.addEventListener('copy', copyHandler);
  prevCopyHandler = copyHandler;

  // 拦截 Ctrl+A: 浏览器默认全选 document(含标题栏 / sidebar / TopBar),
  // 限定 selection 到 .notes-masonry,只让用户看到列表卡片范围被高亮.
  // user-select:none 不阻挡 selectAll(Chromium 标准),靠 CSS 解决不了.
  // 放行规则:
  // - INPUT/TEXTAREA: 用户在输入框 → 默认
  // - Vditor 编辑器有内容: 用户在打字编辑 → 默认(让 Ctrl+A 全选自己写的)
  // - 其他(含编辑器为空 auto-focus): 拦截到列表
  const ctrlAHandler = (e: KeyboardEvent) => {
    if (!((e.ctrlKey || e.metaKey) && e.key === 'a' && !e.shiftKey && !e.altKey)) return;
    const ae = document.activeElement as HTMLElement | null;
    // 光标在搜索框/输入框 内 → 默认(让用户全选输入框内容)
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    // 光标在编辑器(contenteditable)内 → 默认.
    // 代价: 进列表页时编辑器 auto-focus → Ctrl+A 选不到列表,需要先点列表区域取消 focus.
    if (ae?.closest('[contenteditable="true"]')) return;
    // 其他情况(看列表 / sidebar / topbar / 任何非编辑区域)→ 拦截到 .notes-masonry
    const masonry = document.querySelector('.notes-masonry');
    if (!masonry) return; // 非列表页 → 浏览器默认行为
    e.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(masonry);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  document.addEventListener('keydown', ctrlAHandler, true);
  prevCtrlAHandler = ctrlAHandler;

  // 拦截 window.open(兜底:Vditor 可能用 window.open 打开链接)
  const origOpen = window.open.bind(window);
  prevWindowOpen = origOpen;
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

watch(() => auth.user, (user) => {
  if (user) {
    appReady.value = true;
    applyUserPreferences(user);
  }
}, { immediate: true });
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
      <!-- 自定义标题栏(仅 Electron). select-none: Ctrl+A 时不要选这里的"Quink - 一念".
           固定 36px (而非 h-9 = 2.25rem): 标题栏不随用户字体大小 scale, 否则 rem=18 时 h-9=40.5px 引入 .5px
           累积让下游 layout y 落在 .5 倍数 (如 batch bar btn.y=113.5), 浏览器在不同 paint context 下亚像素 round
           不一致 (一边 113 一边 114) → 字符屏幕位置差 1 像素. 固定 px 让所有累积整数, paint 一致. -->
      <div v-if="isElectron" class="flex items-center justify-between h-[36px] pl-3 pr-2 shrink-0 select-none"
        style="-webkit-app-region: drag; background: rgb(var(--c-sidebar))">
        <div class="flex items-center gap-2">
          <img :src="`/quink-${currentTheme}-192.png`" alt="" class="w-4 h-4" draggable="false" />
          <span class="text-xs font-semibold" style="color: var(--sb-text)">Quink - 一念</span>
        </div>
        <div class="flex items-center" style="-webkit-app-region: no-drag">
          <button @click="desk?.minimize()" class="w-10 h-[36px] flex items-center justify-center hover:bg-black/10 transition-colors" style="color: var(--sb-dim)">
            <PhMinus size="1rem" weight="bold" />
          </button>
          <button @click="desk?.maximize()" class="w-10 h-[36px] flex items-center justify-center hover:bg-black/10 transition-colors" style="color: var(--sb-dim)">
            <PhSquare size="0.875rem" weight="bold" />
          </button>
          <button @click="desk?.close()" class="w-10 h-[36px] flex items-center justify-center hover:bg-red-500 hover:text-white transition-colors" style="color: var(--sb-dim)">
            <PhX size="1rem" weight="bold" />
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
          <!-- batch action bar Teleport target: TopBar 的 batch bar 用 Teleport 渲染到这里,
               让 batch bar 物理位置在 main 内 (跟卡片在同一 overflow 容器), 半透明 bg-gray-50/80
               透过去能看到下方卡片轮廓 (跟回收站 sticky toolbar 同款视觉).
               portal 必须包住 RouterView: sticky 元素的钉住范围 = containing block, portal 必须高度 = main 内容全高,
               否则 sticky 范围被限制在 batch bar 自身那 46px 内, 等同 sticky 失效跟随滚动. -->
          <div id="batch-bar-portal">
            <RouterView v-slot="{ Component }">
              <KeepAlive :include="['inspiration', 'notes', 'todos', 'ai-page']">
                <component :is="Component" />
              </KeepAlive>
            </RouterView>
          </div>
        </main>
      </div>
      </div>
    </div>

    <NoteEditModal v-if="editingNote" :note="editingNote" :initial-fullscreen="editFullscreen" @close="closeEditModal" />

    <!-- 引用预览 Modal(z-150 覆盖编辑 modal z-100) -->
    <Teleport to="body">
      <Transition name="modal">
      <div v-if="refPreviewNote && !refPreviewHidden" class="fixed inset-0 z-[150] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30 backdrop-blur-sm" @click="goBackRefPreview" />
        <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl mx-4 max-h-[70vh] flex flex-col overflow-hidden ring-1 ring-black/5">
          <div class="flex items-center justify-between px-5 py-3 bg-gray-50/80 shrink-0">
            <div class="flex items-center gap-2">
              <button @click="goBackRefPreview" class="p-1 rounded-lg hover:bg-gray-200/60 text-gray-400">
                <PhCaretLeft size="1rem" weight="fill" />
              </button>
              <span class="text-xs font-medium text-gray-500">引用预览{{ refPreviewStack.length > 1 ? ` (${refPreviewStack.length})` : '' }}</span>
            </div>
            <div class="flex items-center gap-1">
              <button @click="goToRefNote()" class="px-2 py-1 rounded-lg text-[11px] hover:bg-gray-200/60 transition-colors" style="color: rgb(var(--c-accent-dark))">
                查看详情
              </button>
              <button @click="closeRefPreview" class="p-1 rounded-lg hover:bg-gray-200/60 text-gray-400">
                <PhXCircle size="1rem" weight="fill" />
              </button>
            </div>
          </div>
          <div class="flex-1 overflow-y-auto px-6 py-4">
            <div v-if="refPreviewNote.summary" class="text-sm text-gray-500 italic mb-3">{{ refPreviewNote.summary }}</div>
            <div class="note-content">
              <div class="vditor-reset" v-html="refPreviewHtml" />
            </div>
            <div v-if="refPreviewNote.tags?.length" class="flex flex-wrap gap-1.5 mt-4 pt-3 border-t border-gray-100">
              <span v-for="tag in refPreviewNote.tags" :key="tag" class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">#{{ tag }}</span>
            </div>
          </div>
        </div>
      </div>
      </Transition>
    </Teleport>
  </template>

  <!-- 全局 Toast -->
  <GlobalToast />

  <!-- 全局图片预览(单例,各 view 通过 useImagePreview composable open / close) -->
  <ImagePreview />

  <!-- 全局右键菜单:.note-content 内的图片 / 音频 a 标签右键下载 -->
  <MediaContextMenu />

  <!-- 拖动卡片到 sidebar 时的浮动 ghost (cardDnd.ts pointer events 实现, 替代 HTML5 DnD 的浏览器自带 ghost) -->
  <DragGhost />

  <!-- 附件下载悬浮列表(屏幕中下方, 显示进度 + 取消, 3s 无活动任务自动 fade out) -->
  <AttachmentDownloadDock />
</template>
