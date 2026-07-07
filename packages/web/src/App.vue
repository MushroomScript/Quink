<script setup lang="ts">
import { RouterView, useRoute, useRouter } from 'vue-router';
import { computed, onMounted, provide, ref, watch, nextTick } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useNotesStore } from '@/stores/notes';
import { api, type Note } from '@/api';
import Vditor from 'vditor';
import { initAudioBubbleHandler } from '@/utils/audio';
import { startReminderSse, stopReminderSse } from '@/utils/sse';
import Sidebar from '@/components/Sidebar.vue';
import TopBar from '@/components/TopBar.vue';
import NoteEditModal from '@/components/NoteEditModal.vue';
import GlobalToast from '@/components/GlobalToast.vue';
import { PhMinus, PhSquare, PhX, PhXCircle, PhCaretLeft } from '@phosphor-icons/vue';
import { REF_LINK_REGEX, renderRefLink, injectRefLinkIcons } from '@/utils/refLink';
import { resolveMarkdownFileUrls } from '@/utils/fileUrl';
import { useTheme } from '@/composables/useTheme';
import { useToast } from '@/composables/useToast';
import { useImagePreview } from '@/composables/useImagePreview';
import ImagePreview from '@/components/ImagePreview.vue';
import VideoPreview from '@/components/VideoPreview.vue';
import MediaContextMenu from '@/components/MediaContextMenu.vue';
import DragGhost from '@/components/DragGhost.vue';
import AttachmentDownloadDock from '@/components/AttachmentDownloadDock.vue';
import { addTask as addAttachmentTask } from '@/composables/useAttachmentTasks';
import { openedAttachments } from '@/utils/openedAttachments';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useNotesStore();

// route.name 未定 (首次导航未 resolve) 时 showChrome=false → 走 RouterView 兜底不渲染主界面骨架,
// 避免未登录首帧把 undefined 误判成主界面闪一下. 配合 main.ts 即时 mount (不用 router.isReady 延迟) 一起修.
const showChrome = computed(() => !!route.name && !['login', 'capture', 'float', 'ai-chat', 'translate-result', 'invite'].includes(route.name as string));
const isElectron = !!(window as any).quinkDesktop?.isElectron;
// Mac 标题栏走原生交通灯 (main.ts titleBarStyle:hiddenInset): 左侧给交通灯留位 + 隐藏自绘窗口按钮
const isMac = isElectron && /Mac/i.test(navigator.userAgent);
const desk = (window as any).quinkDesktop;
// 给 html 加 data-electron 让 CSS 能区分 Electron / 浏览器 (用于 .empty-state-center 偏移量等).
if (isElectron) document.documentElement.setAttribute('data-electron', '');
const showMobileSidebar = ref(false);
const appReady = ref(false);
const currentTheme = useTheme();
const { show: showToast } = useToast();

// 附件下载: 进度走悬浮 dock(AttachmentDownloadDock + useAttachmentTasks), 仅在最终 success/failed 弹 toast.
// 进度推送由 main 端 attachmentTasksStore broadcastProgress → useAttachmentTasks 自己监听 attachment-tasks:progress, 这里不再需要桥接.
// 已打开过的 URL Set 从 utils 共享(资源页 Resources 也用同一份做大文件 confirm 检测)

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

// 灵感页 path 从 / 改到 /quink 后 (router/index.ts redirect / → /quink), 主视图实际命中的是 /quink; 保留 / 是死值
const keepAlivePaths = ['/quink', '/notes', '/todos', '/ai'];
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

// 桌面端 open-attachment IPC 返回的 error 是 `HTTP 404` / `HTTP 500` 等裸状态文本.
// 404 = 后端文件被删, 用户看到"HTTP 404"不知所云; 美化成"文件不存在: xxx" 跟 Web fallback 文案一致
function friendlyAttachmentError(err: string | undefined, filename: string): string {
  if (err && /HTTP 404/i.test(err)) return `文件不存在: ${filename}`;
  return `打开失败: ${err || '未知错误'}`;
}

function applyUserPreferences(user: any) {
  if (!user) return;
  const prefs = user.preferences || {};
  // theme / zoomLevel 已改为设备本地 (localStorage 不跟账号): onMounted 启动时已从 localStorage 应用,
  // 这里不再从账号 prefs 覆盖 (每台设备独立记自己的比例/主题).
  // 同步排序偏好到 notesStore (放 App.vue 全局加载点而非只放 Settings: Settings 是路由进去才 mount,
  // 用户启动 app 直接进 Inspiration 时 store.sortBy 必须已是用户偏好, 否则首次 fetchNotes 用默认 'created'
  // 跟用户设定的 'updated' 不一致). 缺失字段不覆盖 (保留 store 默认 'created').
  if (prefs.notesSortBy === 'created' || prefs.notesSortBy === 'updated') {
    store.sortBy = prefs.notesSortBy;
  }
  // 共享笔记显示策略同款放这: 用户首次进主 view 之前必须把偏好推到 store, 否则
  // 启动 → 直接 Inspiration → fetchNotes 用默认 'own' (= mine scope) → 错过用户偏好.
  // 默认 own 跟历史行为一致, 缺失字段不覆盖 (store 默认 'own').
  if (prefs.sharedDisplay === 'own' || prefs.sharedDisplay === 'others' || prefs.sharedDisplay === 'none' || prefs.sharedDisplay === 'all') {
    store.sharedDisplay = prefs.sharedDisplay;
  }
}

// 显示比例应用逻辑. 入口只有 Settings 页 (Ctrl+滚轮已废除, 见 packages/desktop/CLAUDE.md zoom 段).
// Electron 端: 主进程 setZoomFactor 给 3 个窗口同步; Web/PWA 端: CSS zoom (二选一, 双方同设会双重缩放).
// localStorage 缓存让 inline script + 创建快捷窗口前 ensureCurrentZoomLevel 拿得到上次值, 避开服务端慢启动 / preferences 不完整 race.
function applyZoomLevel(level: number) {
  localStorage.setItem('quink_zoom_level', String(level));
  if ((window as any).quinkDesktop?.isElectron) {
    // Electron 路径: 走 syncZoom IPC, main 端 setZoomFactor 设 webContents zoom. 同时清掉 CSS zoom 残留,
    // 防 web → Electron 切换时 documentElement.style.zoom 残留跟 setZoomFactor 双重缩放.
    // 快捷窗口的 syncZoom 是 no-op stub (preload.ts) — 它们的 zoom 由主窗口 sync-zoom IPC 触达, 不需要
    // 自己 IPC. 但 isElectron=true 让这分支跑, 走过清 CSS zoom 那一行就足够防双重.
    (document.documentElement.style as any).zoom = '';
    try { (window as any).quinkDesktop.syncZoom(level); } catch {}
    // Electron 端走 setZoomFactor, window.innerHeight 已是逻辑值 (缩放体现在 devicePixelRatio, 不在 innerHeight),
    // setAppHeight 传 1 即可. 传 level/100 会把 --app-height 多除一次 factor → #app 高度腰斩. 主窗口靠 syncZoom
    // → main 改物理尺寸触发的 resize 事件重算 (zoom=1) 掩盖了; 但 float 快捷窗口 syncZoom 是 no-op stub, 不触发
    // resize, 腰斩值不被覆盖 → 胶囊 bar 高度只剩 ~1/5 (padding 固定, 吃掉腰斩后剩余高度的大头).
    try { (window as any).__quink_setAppHeight?.(1); } catch {}
  } else {
    (document.documentElement.style as any).zoom = (level / 100).toString();
    // Web/PWA 端 CSS zoom: innerHeight 是 zoomed value, 除 factor 还原 unzoomed CSS px. 直接传确切 zoom 不让
    // setAppHeight 读 DOM (getComputedStyle 滞后 / style.zoom 边界全绕开), 保证切换即刻用新比例算 → 不用刷新就居中.
    try { (window as any).__quink_setAppHeight?.(level / 100); } catch {}
  }
}

// HMR 友好：模块级保存上次挂的副作用，重 mount 时先清理旧的，避免 capture 阶段旧 handler
// 抢先 stopImmediatePropagation 调用旧闭包里的 openRefPreview（操作旧响应式状态，新 UI 看不到预览）。
let prevRefClickHandler: ((e: MouseEvent) => void) | null = null;
let prevImgClickHandler: ((e: MouseEvent) => void) | null = null;
let prevMissingImgErrHandler: ((e: Event) => void) | null = null;
let prevCopyHandler: ((e: ClipboardEvent) => void) | null = null;
let prevCtrlAHandler: ((e: KeyboardEvent) => void) | null = null;
let prevWindowOpen: typeof window.open | null = null;

const { open: openImagePreview } = useImagePreview();

onMounted(async () => {
  initAudioBubbleHandler();
  // 显示比例 + 主题: 设备本地 (localStorage 不跟账号) → 启动即应用, 不等 fetchMe、不受未登录 return 影响.
  // inline script 已即时应用防闪, 这里 applyZoomLevel 做完整应用 (Electron syncZoom + setAppHeight 重算).
  const localTheme = localStorage.getItem('quink_theme');
  if (localTheme) document.documentElement.setAttribute('data-theme', localTheme);
  applyZoomLevel(parseInt(localStorage.getItem('quink_zoom_level') || '') || 100);
  // 把 localStorage 中存的下载目录推给 main, will-download 用它. 没设过的话 main 默认 ~/Downloads
  try {
    const dlDir = localStorage.getItem('quink_download_dir');
    if (dlDir) desk?.syncDownloadPath?.(dlDir);
  } catch {}
  const user = await auth.fetchMe();
  appReady.value = true;
  if (!user) return;
  applyUserPreferences(user);

  // 启动提醒 SSE: 长连接接收 server 推送, 收到 reminder 事件 → Electron 原生通知 / 浏览器 Notification
  startReminderSse();
  // Electron 点击系统通知 → 主窗口跳笔记详情 (老 reminder 路径)
  (window as any).quinkDesktop?.onOpenNote?.((noteId: string) => {
    if (noteId && noteId !== 'test') router.push(`/note/${noteId}`);
  });
  // Electron 点击通用通知 → 跳指定 path (群组事件 / 未来场景共用)
  (window as any).quinkDesktop?.onOpenPath?.((path: string) => {
    if (path) router.push(path);
  });

  // 清理 HMR 残留
  if (prevRefClickHandler) document.removeEventListener('click', prevRefClickHandler, true);
  if (prevImgClickHandler) document.removeEventListener('click', prevImgClickHandler, true);
  if (prevMissingImgErrHandler) document.removeEventListener('error', prevMissingImgErrHandler, true);
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

  // 全局拦截 <img src="/api/uploads/*"> 加载失败 → replaceWith 红色"⚠ 文件不存在：xxx" 占位 span.
  // capture phase: error 事件默认不冒泡 (仅在 target 触发), 必须 capture 才能在 document 层收到所有 img 失败.
  // 用全局 listener 而非 md2html 后处理时给每个 <img> 加 inline onerror= 的好处:
  // - CSP script-src 严格策略下 inline JS 被拦, 全局 listener 不依赖 inline
  // - 不用在每个渲染入口 (NoteCard/NoteDetail/Trash/AI/AiChat/App ref 预览) 都套一层 helper, 一次注册全覆盖
  // dataset.quinkMissingDone 防重复处理 (v-html 重新渲染后 img 重新挂上 src 会再次触发 error)
  const missingImgErrHandler = (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (!t || t.tagName !== 'IMG') return;
    const img = t as HTMLImageElement;
    const src = img.getAttribute('src') || '';
    if (!src.startsWith('/api/uploads/')) return;
    // .thumb.jpg 404 不等于"文件不存在": 后端 sharp 未生成 thumb 是常见情况(老文件 / sharp 失败 / 刚上传).
    // 让局部 @error="thumbErrorFallback" 把 src 切回原图, 原图也 404 时浏览器会再次触发 error,
    // 那次 src 已是原图(不带 .thumb.jpg), capture listener 接管显示占位
    // 注意: src 含 ?token=... query 时 endsWith 会被 token 后缀挡, 必须剥 query 再判断 (老 PNG/HEIC thumb 404 fallback 时被这条挡住误替换为 missing span)
    if (src.split('?')[0].endsWith('.thumb.jpg')) return;
    if (img.dataset.quinkMissingDone === '1') return;
    img.dataset.quinkMissingDone = '1';
    const alt = img.getAttribute('alt') || '图片';
    const span = document.createElement('span');
    span.className = 'quink-missing-file';
    span.textContent = '⚠ 文件不存在：' + alt;
    img.replaceWith(span);
  };
  document.addEventListener('error', missingImgErrHandler, true);
  prevMissingImgErrHandler = missingImgErrHandler;

  // 全局拦截引用链接单击 → 弹预览(不走路由,不打开新标签)
  // 同时拦截 /api/uploads/* 附件链接 → 桌面端调系统默认应用打开,web 端走浏览器下载。
  // 否则浏览器跟随 a.href 跳走,Electron 内嵌 chromium 对 text/markdown 等 mime 显示空白页。
  const handler = async (e: MouseEvent) => {
    // programmatic click (link.click() / dispatchEvent) e.isTrusted=false, 跳过本 handler.
    // 防 web fallback 死循环: web 端附件下载靠创建临时 <a download> + link.click() 触发原生下载,
    // 那次冒泡会再次进本 handler → 又匹配 /api/uploads/ 分支 → 又 preventDefault + 又创建临时 a → 死循环,
    // 用户感觉"点文件没反应"(浏览器后台反复发 HEAD 但原生下载被反复 preventDefault).
    if (!e.isTrusted) return;
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
    // Web 端外链 (http/https 且不含 /api/uploads/) 强制新标签: 否则浏览器跟随 a.href 导航 → 整个 SPA 跳走丢上下文 / KeepAlive 状态.
    // 桌面端不动: Electron main 已用 setWindowOpenHandler + will-navigate 把外链交给系统浏览器 (packages/desktop/src/main.ts).
    // 排除 /api/uploads/: 罕见情况下 markdown 可能写绝对附件 URL (http://host/api/uploads/x.txt), 让下面附件分支接管走 dock/下载, 不要开新标签.
    if (!desk && /^https?:\/\//i.test(href) && !href.includes('/api/uploads/')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    // 正则容忍 ?token=... query (加 query 后 .m4a 不匹配 $ → 音频误进下载分支 → 巨长 toast + 下载文件)
    if (href.includes('/api/uploads/') && !/\.(png|jpg|jpeg|gif|webp|svg|webm|mp3|wav|ogg|m4a)(\?.*)?$/i.test(href)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const fullUrl = new URL(href, location.origin).toString();
      // 剥 ?token=... query 防 task.filename 显示成 'xxx.m4a?token=eyJ...EACs' 巨长 (hover tooltip / dock title 都用 filename)
      const filename = decodeURIComponent((href.split('/').pop() || '附件').split('?')[0]);

      // 统一先 HEAD 检查 → 404 / 网络错误直接 toast, 不进传输 dock (避免 dock 闪一下 failed 状态留个垃圾记录).
      // 缓存命中 (之前成功打开过) 跳过 HEAD: main 端会直接 openPath 临时文件, 不再 fetch.
      const isCached = !!(desk?.openAttachment) && openedAttachments.has(fullUrl);
      if (!isCached) {
        try {
          const head = await fetch(href, { method: 'HEAD' });
          if (!head.ok) {
            showToast(head.status === 404 ? `文件不存在: ${filename}` : `打开失败: HTTP ${head.status}`, 'error', 3000);
            return;
          }
        } catch {
          showToast('打开失败: 网络错误', 'error', 3000);
          return;
        }
      }

      if (desk?.openAttachment) {
        // renderer 端 cache: 之前成功打开过这个 URL → 跳过 dock 直接 invoke + toast.
        // 跟 main 端 attachmentCache 同生命周期(都是进程内 Map, 重启都清), 不会出现 renderer 觉得
        // 有 cache 但 main 那边却没 cache 的情况
        if (openedAttachments.has(fullUrl)) {
          const result = await desk.openAttachment(fullUrl);
          if (result?.success) {
            showToast(`已打开 ${filename}`, 'success', 1500);
          } else {
            showToast(friendlyAttachmentError(result?.error, filename), 'error', 3000);
          }
          return;
        }
        // 第一次打开: 走 dock 全流程. main 端 open-attachment 自己调 store.markSuccessByUrl / markFailedByUrl / removeByUrl,
        // sync 事件会推到本地 ref 更新 dock, 这里只负责 toast + 标记 openedAttachments 让下次跳过 dock.
        // await: addAttachmentTask 异步, 等 main 端 store add 完成再 invoke open-attachment 防 race (两个 IPC 不同 channel 无顺序保证)
        await addAttachmentTask(fullUrl, filename);
        const result = await desk.openAttachment(fullUrl);
        if (result?.success) {
          openedAttachments.add(fullUrl);
          showToast(`已打开 ${filename}`, 'success', 1500);
        } else if (!result?.cancelled) {
          showToast(friendlyAttachmentError(result?.error, filename), 'error', 3000);
        }
      } else {
        // Web 端 fallback: HEAD 已通过, 用 a.download 触发浏览器原生下载
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
  // 每张卡片 = [类型 · 分类 · 时间] + 正文 + tags, 中间用 --- 分隔.
  // 单卡片 / 详情 (.note-content / .vditor-reset 渲染区): selection.toString() 在跨 <p> 时加 \n\n 但用户视觉只看 1 换行,
  // 跟单 <p> 内 <br><br> (视觉 1 空行) 文本上分不开 (selStr 都是 "\n\n"). 走 walk DOM 区分:
  //   - 每个块元素 (P/DIV/LI/H*) 结束加 1 个 \n (不加 2 个浏览器多余)
  //   - <br> 加 1 个 \n
  // 结果:
  //   <p>1</p><p>2</p> → "1\n2" (无空行, 段落间距视觉对应)
  //   <p>1<br><br>2</p> → "1\n\n2" (1 空行, 双 br 视觉对应)
  //   <p>1</p><br><p>2</p> → "1\n\n2" (1 空行, 跨段 br 视觉对应)
  // 编辑器 (Vditor) 内复制: RichEditor.onEditorCopy capture phase + stopPropagation 已拦, 不会触发到这里
  const walkMarkdownDom = (fragment: DocumentFragment): string => {
    let text = '';
    const blockTags = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);
    const walk = (node: Node) => {
      if (node.nodeType === 3) {
        // text node: 去掉首尾 \n (innerHTML 里 </p>\n<p> 的 \n 是 text node, 不该算)
        text += (node.textContent || '').replace(/^\n+|\n+$/g, '');
      } else if (node.nodeType === 1) {
        const el = node as Element;
        const tag = el.tagName;
        if (tag === 'BR') {
          text += '\n';
        } else if (blockTags.has(tag)) {
          for (const c of Array.from(el.childNodes)) walk(c);
          text += '\n';
        } else {
          for (const c of Array.from(el.childNodes)) walk(c);
        }
      }
    };
    for (const c of Array.from(fragment.childNodes)) walk(c);
    return text.replace(/\n+$/, '');
  };
  const copyHandler = (e: ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    // 收集 selection 跨过的所有 NoteCard
    const cards = document.querySelectorAll('.notes-masonry .masonry-col > div');
    const touched: Element[] = [];
    for (const card of cards) {
      if (sel.containsNode(card, true)) touched.push(card);
    }
    if (touched.length >= 2) {
      const blocks = touched.map(card => {
        // type 标签自己也带 .text-[11px] class,跟时间区分:type 是 .rounded-full, 时间是 .ml-auto
        const type = card.querySelector('.flex.items-center.gap-2 > .rounded-full')?.textContent?.trim() || '';
        const category = card.querySelector('.flex.items-center.gap-2 > .text-xs:not(.rounded-full)')?.textContent?.trim() || '';
        const time = card.querySelector('.flex.items-center.gap-2 > .ml-auto')?.textContent?.trim() || '';
        const headerLine = [type, category, time].filter(Boolean).join(' · ');
        const summary = card.querySelector('p.italic')?.textContent?.trim() || '';
        // 走 walkMarkdownDom 把整个 .note-content 内的 markdown DOM 转干净文本 (跟单卡片同款规则)
        let content = '';
        const noteContent = card.querySelector('.note-content');
        if (noteContent) {
          const frag = document.createDocumentFragment();
          for (const c of Array.from(noteContent.childNodes)) frag.appendChild(c.cloneNode(true));
          content = walkMarkdownDom(frag);
        }
        const tags = [...card.querySelectorAll('.flex.flex-wrap > span')].map(s => s.textContent?.trim()).filter(Boolean).join(' ');
        const parts = [headerLine, summary, content, tags].filter(Boolean);
        return parts.join('\n');
      });
      e.preventDefault();
      e.clipboardData?.setData('text/plain', blocks.join('\n\n---\n\n'));
      return;
    }
    // 单卡片 / 详情: 在 markdown 渲染区时走 walkMarkdownDom 区分段落 vs <br><br>
    const anchor = sel.anchorNode;
    const targetEl = (anchor?.nodeType === 3 ? anchor.parentElement : (anchor as HTMLElement | null));
    const inMarkdown = targetEl?.closest?.('.note-content, .vditor-reset');
    if (!inMarkdown) return;
    const range = sel.getRangeAt(0);
    const fragment = range.cloneContents();
    if (!fragment.hasChildNodes()) return;
    const text = walkMarkdownDom(fragment);
    if (!text) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
  };
  document.addEventListener('copy', copyHandler);

  // 拦截 Ctrl+A:
  // - 多选模式(store.selectMode=true): 选中所有卡片(加进 selectedIds), 不选文字
  // - 非多选模式: 浏览器默认全选 document(含标题栏 / sidebar / TopBar) 体验差,
  //   限定 selection 到 .notes-masonry, 只让用户看到列表卡片范围被高亮.
  //   user-select:none 不阻挡 selectAll(Chromium 标准), 靠 CSS 解决不了.
  // 放行规则(两种模式共用):
  // - INPUT/TEXTAREA: 用户在输入框 → 默认
  // - Vditor 编辑器(contenteditable)内: 用户在打字编辑 → 默认(让 Ctrl+A 全选自己写的)
  const ctrlAHandler = (e: KeyboardEvent) => {
    if (!((e.ctrlKey || e.metaKey) && e.key === 'a' && !e.shiftKey && !e.altKey)) return;
    const ae = document.activeElement as HTMLElement | null;
    // 光标在搜索框/输入框 内 → 默认(让用户全选输入框内容). 不论 selectMode 都放行,
    // 用户在搜索框输入时按 Ctrl+A 期待的是选中输入框文本而不是切换多选状态.
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    // 多选模式: 选中所有卡片 (优先级最高, 即使光标在隐藏的编辑器内 contenteditable 也覆盖,
    // 因为 v-show 隐藏 NoteInput 时编辑器还能保持 focus, 若放行就会让 selectMode 下 Ctrl+A 失灵)
    if (store.selectMode) {
      e.preventDefault();
      store.selectAll();
      return;
    }
    // 光标在编辑器(contenteditable)内 → 默认.
    // 代价: 进列表页时编辑器 auto-focus → Ctrl+A 选不到列表/卡片,需要先点列表区域取消 focus.
    if (ae?.closest('[contenteditable="true"]')) return;
    // 普通模式:
    // - 列表页 → 选整个 .notes-masonry
    // - 详情页 → 只选笔记正文 .note-detail-content .vditor-reset (跟右键菜单"全选"一致, 跳过类型/分类/时间/summary/tags)
    // - 其他页面 → 浏览器默认
    const masonry = document.querySelector('.notes-masonry');
    const detailContent = !masonry ? document.querySelector('.note-detail-content .vditor-reset') : null;
    const target = masonry || detailContent;
    if (!target) return;
    e.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(target);
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
      <div v-if="isElectron" class="relative flex items-center justify-between h-[36px] pr-2 shrink-0 select-none"
        :class="isMac ? 'pl-[78px]' : 'pl-3'"
        style="-webkit-app-region: drag; background: rgb(var(--c-sidebar))">
        <div v-if="!isMac" class="flex items-center gap-2">
          <img :src="`/quink-${currentTheme}-192.png`" alt="" class="w-4 h-4" draggable="false" />
          <span class="text-xs font-semibold" style="color: var(--sb-text)">Quink - 一念</span>
        </div>
        <!-- Mac: 标题水平居中 (跟随其他 mac app 风格), 交通灯在左、标题居中、右侧空 -->
        <span v-if="isMac" class="absolute left-1/2 -translate-x-1/2 text-xs font-semibold pointer-events-none" style="color: var(--sb-text)">Quink - 一念</span>
        <div v-if="!isMac" class="flex items-center" style="-webkit-app-region: no-drag">
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
      <div v-if="showMobileSidebar" class="fixed inset-0 z-[var(--z-sidebar)] md:hidden">
        <div class="absolute inset-0 bg-black/40" @click="showMobileSidebar = false" />
        <div class="absolute left-0 -top-[200px] -bottom-[200px] w-60 shadow-2xl overflow-y-auto bg-sidebar pt-[200px] pb-[200px]" @click.stop>
          <Sidebar />
        </div>
      </div>

      <div class="flex-1 flex flex-col overflow-hidden">
        <TopBar />
        <main ref="mainEl" class="flex-1 relative overflow-y-auto" style="scrollbar-gutter: stable">
          <!-- batch action bar Teleport target: TopBar 的 batch bar 用 Teleport 渲染到这里,
               让 batch bar 物理位置在 main 内 (跟卡片在同一 overflow 容器), 半透明 bg-gray-50/80
               透过去能看到下方卡片轮廓 (跟回收站 sticky toolbar 同款视觉).
               portal 必须包住 RouterView: sticky 元素的钉住范围 = containing block, portal 必须高度 = main 内容全高,
               否则 sticky 范围被限制在 batch bar 自身那 46px 内, 等同 sticky 失效跟随滚动.
               h-full: 让子 view 的 min-h-full / h-full 链条工作 (CSS 规范要求父 height 是 definite 才让子 % 生效, min-h-full 不算).
               配合 .empty-state-center 在 Resources 等多层嵌套 view 内 absolute 锚到根 div 正常居中.
               h-full 不破坏滚动: 内容超出时溢出可见, main 的 overflow-y-auto 仍能滚到 batch-bar-portal 外的内容. -->
          <div id="batch-bar-portal" class="h-full">
            <!-- batch bar 落点: 必须在 RouterView 之前. 否则 Teleport 把 batch bar 追加到 portal 末尾 = 排到笔记
                 列表后面, sticky 钉在列表最底 (刷新直接进多选时按钮沉到屏幕底部). 空 div 不占高度, 不影响布局. -->
            <div id="batch-bar-slot"></div>
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

    <!-- 引用预览 Modal(z-modal-preview 覆盖编辑 modal z-modal-edit) -->
    <Teleport to="body">
      <Transition name="modal">
      <div v-if="refPreviewNote && !refPreviewHidden" class="fixed inset-0 z-[var(--z-modal-preview)] flex items-center justify-center">
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
          <div class="flex-1 min-h-0 overflow-y-auto px-6 py-4">
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

  <!-- 全局视频预览(单例,资源页 list view 点视频 / 笔记 video 链接共享) -->
  <VideoPreview />

  <!-- 全局右键菜单:.note-content 内的图片 / 音频 a 标签右键下载 -->
  <MediaContextMenu />

  <!-- 拖动卡片到 sidebar 时的浮动 ghost (cardDnd.ts pointer events 实现, 替代 HTML5 DnD 的浏览器自带 ghost) -->
  <DragGhost />

  <!-- 附件下载悬浮列表(屏幕中下方, 显示进度 + 取消, 3s 无活动任务自动 fade out) -->
  <AttachmentDownloadDock />
</template>
