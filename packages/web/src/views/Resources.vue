<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide, watch } from 'vue';
import { api, isLoggedIn } from '@/api';
import { useNotesStore } from '@/stores/notes';
import { fadeOutLeave, snapshotCards } from '@/utils/cardLeave';
import { useImagePreview } from '@/composables/useImagePreview';
import { resolveFileUrl } from '@/utils/fileUrl';
import { pinyinMatch } from '@/utils/pinyin';
import AudioPlayer from '@/components/AudioPlayer.vue';
import { useEscToClose } from '@/composables/useEscToClose';
import { useToast } from '@/composables/useToast';
import { resourceBreadcrumb, resourceBreadcrumbGoTo } from '@/composables/useResourceBreadcrumb';

const store = useNotesStore();
const toast = useToast();
import {
  PhFolder,
  PhFolderSimple,
  PhFolderPlus,
  PhFilePdf,
  PhFileText,
  PhFileZip,
  PhFile,
  PhXCircle,
  PhSquaresFour,
  PhListBullets,
  PhCaretRight,
  PhHouse,
} from '@phosphor-icons/vue';

interface FileItem {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  category: string;
  size: number;
  createdAt: string;
  folderId: string | null;
}

interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

const files = ref<FileItem[]>([]);
const folders = ref<FolderItem[]>([]);
// null = 根目录, 否则是当前所在 folder id
const currentFolderId = ref<string | null>(null);

const pageCount = computed(() => filtered.value.length + filteredFolders.value.length);
provide('pageCount', pageCount);
const loading = ref(true);
const confirmDeleteId = ref('');
const confirmBatchDelete = ref(false);
// 重命名文件: target 持有原文件 reference + 当前 input 值
const renameTarget = ref<FileItem | null>(null);
const renameValue = ref('');
// 重命名文件夹
const renameFolderTarget = ref<FolderItem | null>(null);
const renameFolderValue = ref('');
// 删除文件夹确认
const confirmDeleteFolderId = ref('');
const deleteFolderAlsoFiles = ref(false);
// 新建文件夹
const createFolderOpen = ref(false);
const createFolderName = ref('');
// 移动文件到文件夹弹窗
const moveTargetOpen = ref(false);
useEscToClose(confirmDeleteId, '');
useEscToClose(renameTarget, null);
useEscToClose(renameFolderTarget, null);
useEscToClose(confirmDeleteFolderId, '');
useEscToClose(confirmBatchDelete);
useEscToClose(createFolderOpen);
useEscToClose(moveTargetOpen);
const renameInput = ref<HTMLInputElement | null>(null);
const renameFolderInput = ref<HTMLInputElement | null>(null);
const createFolderInput = ref<HTMLInputElement | null>(null);
const imageFiles = computed(() => filtered.value.filter(isImage));
const { open: openImagePreview } = useImagePreview();

// ── 多选 (Ctrl+点击 / 选择按钮 触发) ──
const selectMode = ref(false);
const selectedIds = ref<Set<string>>(new Set());
useEscToClose(selectMode);
watch(selectMode, (v) => { if (!v) selectedIds.value.clear(); });

function toggleSelect(id: string) {
  if (selectedIds.value.has(id)) selectedIds.value.delete(id);
  else selectedIds.value.add(id);
}

// 全选当前目录下所有 filtered files (不含文件夹本身, 文件夹不支持多选)
function selectAllFiles() {
  selectMode.value = true;
  for (const f of filtered.value) selectedIds.value.add(f.id);
}

// Ctrl/Cmd+A 全选 (仅资源页 + 多选模式生效, 避免覆盖系统默认 select-all behaviour)
function onKeydown(e: KeyboardEvent) {
  if (!selectMode.value) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
    // 别在输入框 / 文本框里抢: 让用户能在 input 内正常 ctrl+a 全选输入内容
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    selectAllFiles();
  }
}

function onCardClick(e: MouseEvent, f: FileItem) {
  // 拖动检测放最前: pointerdown→pointerup 距离超阈值就当 drag, click 直接 return 不要 toggleSelect.
  // 否则: 多选模式下拖动一张已选中卡片半路放手 (没拖到 dropzone), click 仍 fire 把这张反向 toggleSelect 取消选中, 体验突兀
  if (Math.abs(e.clientX - dragStartX) > DRAG_THRESHOLD || Math.abs(e.clientY - dragStartY) > DRAG_THRESHOLD) return;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    selectMode.value = true;
    toggleSelect(f.id);
    return;
  }
  if (selectMode.value) {
    e.preventDefault();
    e.stopPropagation();
    toggleSelect(f.id);
    return;
  }
  // 非选择模式下默认行为: 图片才打开预览, 其他不动 (按钮在 hover 区)
  if (isImage(f)) onImageClick(f);
}

// ── 剪切板 (本地 state, 不持久化, 跳页 / 刷新即失效) ──
const cutBuffer = ref<{ ids: string[]; sourceFolderId: string | null } | null>(null);

// 同步 selectedIds + cutBuffer 跟实际 files: 文件被外部删 / 移走后清除 stale id, 避免"已选 N 项"虚高 / 粘贴时 noop
watch(() => files.value.map(f => f.id), (newIds) => {
  const valid = new Set(newIds);
  // 清 selectedIds 中已不存在的
  let changed = false;
  const cleaned = new Set<string>();
  for (const id of selectedIds.value) {
    if (valid.has(id)) cleaned.add(id);
    else changed = true;
  }
  if (changed) selectedIds.value = cleaned;
  // 清 cutBuffer 中已不存在的
  if (cutBuffer.value) {
    const validCut = cutBuffer.value.ids.filter(id => valid.has(id));
    if (validCut.length === 0) cutBuffer.value = null;
    else if (validCut.length !== cutBuffer.value.ids.length) cutBuffer.value = { ...cutBuffer.value, ids: validCut };
  }
});

function cutSelected() {
  cutBuffer.value = { ids: Array.from(selectedIds.value), sourceFolderId: currentFolderId.value };
  selectMode.value = false;
}

async function pasteHere() {
  if (!cutBuffer.value) return;
  const { ids } = cutBuffer.value;
  // 乐观更新: 本地 files folderId 立即改
  for (const f of files.value) {
    if (ids.includes(f.id)) f.folderId = currentFolderId.value;
  }
  cutBuffer.value = null;
  try {
    await api.moveFiles(ids, currentFolderId.value);
  } catch (e) {
    console.error('[pasteHere] failed:', e);
    // 失败重拉
    load();
  }
}

// ── 视图切换 grid / list, localStorage 记忆 ──
const VIEW_KEY = 'quink_resources_view';
const viewMode = ref<'grid' | 'list'>(((localStorage.getItem(VIEW_KEY) as any) === 'list') ? 'list' : 'grid');
watch(viewMode, (v) => localStorage.setItem(VIEW_KEY, v));

function onImageClick(f: FileItem) {
  const imgs = imageFiles.value.map(x => ({ url: resolveFileUrl(x.url), filename: x.filename }));
  const idx = imageFiles.value.findIndex(x => x.id === f.id);
  openImagePreview(imgs, Math.max(0, idx));
}

const filters = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'audio', label: '音频' },
  { value: 'document', label: '文档' },
];

// 当前 folder 内的文件 (递归过滤: 仅显示直接子文件, 不展开子文件夹的文件)
const filesInCurrent = computed(() => files.value.filter(f => f.folderId === currentFolderId.value));

const filtered = computed(() => {
  // 有搜索时跨当前 folder 整棵子树过滤 (Windows 风格递归搜索); 无搜索时仅当前 folder 直接子
  const tree = treeFolderIds.value;
  let list = tree ? files.value.filter(f => tree.has(f.folderId)) : filesInCurrent.value;
  if (store.fileCategory !== 'all') list = list.filter(f => f.category === store.fileCategory);
  const q = store.searchQuery?.trim();
  if (q) list = list.filter(f => pinyinMatch(f.filename, q));
  if (store.fileDateFrom) list = list.filter(f => f.createdAt.slice(0, 10) >= store.fileDateFrom);
  if (store.fileDateTo) list = list.filter(f => f.createdAt.slice(0, 10) <= store.fileDateTo);
  return list;
});

// 当前 folder 的直接子文件夹
const visibleFolders = computed(() => folders.value.filter(f => f.parentId === currentFolderId.value));

// 有搜索 query 时跨当前 folder 整棵子树搜文件 (Windows 风格), 文件夹只看名字匹配; 无 query 时仅看直接子
const hasSearchQuery = computed(() => !!store.searchQuery?.trim());
const treeFolderIds = computed(() => {
  if (!hasSearchQuery.value) return null;
  const include = new Set<string | null>([currentFolderId.value]);
  let queue: (string | null)[] = [currentFolderId.value];
  while (queue.length) {
    const next: (string | null)[] = [];
    for (const fid of queue) {
      for (const f of folders.value) {
        if (f.parentId === fid && !include.has(f.id)) {
          include.add(f.id);
          next.push(f.id);
        }
      }
    }
    queue = next;
  }
  return include;
});
// 文件夹: 有搜索时仅名字匹配的 (跨全树, 不限父); 无搜索时当前 folder 直接子
const filteredFolders = computed(() => {
  const q = store.searchQuery?.trim();
  if (!q) return visibleFolders.value;
  return folders.value.filter(f => pinyinMatch(f.name, q));
});
// 跳转到 file/folder 所在的父目录 (用于搜索结果的"打开所在位置")
function openFileLocation(f: FileItem) {
  store.searchQuery = '';
  currentFolderId.value = f.folderId;
  selectedIds.value.clear();
}
function openFolderLocation(folder: FolderItem) {
  store.searchQuery = '';
  currentFolderId.value = folder.parentId;
  selectedIds.value.clear();
}

// 当前 folder 及其 parentId (用于 ".." 上级卡片). 根目录时 currentFolder = null, 不显示 ".."
const currentFolder = computed(() => folders.value.find(f => f.id === currentFolderId.value) || null);
const parentFolderId = computed(() => currentFolder.value?.parentId ?? null);

// 面包屑: 从根到当前 folder 的路径
const breadcrumb = computed(() => {
  const path: FolderItem[] = [];
  let id = currentFolderId.value;
  while (id) {
    const f = folders.value.find(x => x.id === id);
    if (!f) break;
    path.unshift(f);
    id = f.parentId;
  }
  return path;
});
// 把面包屑数据同步到 module-level ref 给 TopBar 读 (provide/inject 不能跨 flex sibling)
watch(breadcrumb, (v) => {
  resourceBreadcrumb.value = v.map(b => ({ id: b.id, name: b.name }));
}, { immediate: true });
resourceBreadcrumbGoTo.value = (id: string | null) => {
  if (selectMode.value) return; // 选择模式锁定路径, 面包屑也不响应跳转
  currentFolderId.value = id;
  selectedIds.value.clear();
};
onUnmounted(() => {
  resourceBreadcrumb.value = [];
  resourceBreadcrumbGoTo.value = null;
});

watch(() => filtered.value.length, () => snapshotCards(), { flush: 'sync' });

async function load() {
  if (!isLoggedIn()) return;
  loading.value = true;
  try {
    const [filesRes, foldersRes] = await Promise.all([api.getFiles(), api.getFolders()]);
    files.value = filesRes.data;
    folders.value = foldersRes.data;
  } catch {}
  loading.value = false;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function isImage(f: FileItem) { return f.mimeType.startsWith('image/'); }
function isAudio(f: FileItem) { return f.mimeType.startsWith('audio/'); }

function startRename(f: FileItem) {
  renameTarget.value = f;
  renameValue.value = f.filename;
  setTimeout(() => {
    const el = renameInput.value;
    if (!el) return;
    el.focus();
    const dotIdx = renameValue.value.lastIndexOf('.');
    el.setSelectionRange(0, dotIdx > 0 ? dotIdx : renameValue.value.length);
  }, 50);
}

async function doRename() {
  if (!renameTarget.value) return;
  const name = renameValue.value.trim();
  const target = renameTarget.value;
  if (!name || name === target.filename) { renameTarget.value = null; return; }
  try {
    await api.renameFile(target.id, name);
    files.value = files.value.map(f => f.id === target.id ? { ...f, filename: name } : f);
  } catch (e) { console.error('[Resources] rename failed', e); }
  renameTarget.value = null;
}

async function doDeleteFile() {
  const id = confirmDeleteId.value;
  confirmDeleteId.value = '';
  if (!id) return;
  try { await api.deleteFile(id); files.value = files.value.filter(f => f.id !== id); } catch {}
}

async function doBatchDelete() {
  confirmBatchDelete.value = false;
  const ids = Array.from(selectedIds.value);
  if (!ids.length) return;
  files.value = files.value.filter(f => !ids.includes(f.id));
  selectMode.value = false;
  await Promise.all(ids.map(id => api.deleteFile(id).catch(e => console.error('[batchDelete]', id, e))));
}

function triggerUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,audio/*,.pdf,.txt,.md,.json,.zip,.doc,.docx,.xls,.xlsx';
  input.multiple = true;
  input.onchange = async () => {
    if (!input.files) return;
    const fileList = Array.from(input.files);
    if (!fileList.length) return;
    // Promise.all 并发 + 总进度 toast (原来 sequential await for-loop, 大文件慢且无进度反馈)
    const toastId = toast.show(`正在上传 ${fileList.length} 个文件...`, { duration: 5 * 60 * 1000 });
    const results = await Promise.all(fileList.map(file =>
      api.uploadFile(file, 'file', { folderId: currentFolderId.value })
        .then(() => ({ ok: true, name: file.name }))
        .catch(e => { console.error('[upload]', file.name, e); return { ok: false, name: file.name }; })
    ));
    toast.dismiss(toastId);
    const ok = results.filter(r => r.ok).length;
    const fail = results.length - ok;
    if (fail === 0) toast.show(`已上传 ${ok} 个文件`, 'success');
    else toast.show(`上传完成: ${ok} 成功, ${fail} 失败`, fail === results.length ? 'error' : 'default');
    load();
  };
  input.click();
}

function clearDateFilter() {
  store.fileDateFrom = '';
  store.fileDateTo = '';
}

// ── 文件夹 CRUD ──
function startCreateFolder() {
  createFolderOpen.value = true;
  createFolderName.value = '';
  setTimeout(() => createFolderInput.value?.focus(), 50);
}

async function doCreateFolder() {
  const name = createFolderName.value.trim();
  if (!name) return;
  try {
    const res = await api.createFolder(name, currentFolderId.value);
    folders.value.push(res.data);
    createFolderOpen.value = false;
  } catch (e) {
    console.error('[createFolder]', e);
  }
}

function startRenameFolder(f: FolderItem) {
  renameFolderTarget.value = f;
  renameFolderValue.value = f.name;
  setTimeout(() => {
    const el = renameFolderInput.value;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, renameFolderValue.value.length);
  }, 50);
}

async function doRenameFolder() {
  if (!renameFolderTarget.value) return;
  const name = renameFolderValue.value.trim();
  const target = renameFolderTarget.value;
  if (!name || name === target.name) { renameFolderTarget.value = null; return; }
  try {
    await api.renameFolder(target.id, name);
    folders.value = folders.value.map(f => f.id === target.id ? { ...f, name } : f);
  } catch (e) { console.error('[renameFolder]', e); }
  renameFolderTarget.value = null;
}

async function doDeleteFolder() {
  const id = confirmDeleteFolderId.value;
  const alsoFiles = deleteFolderAlsoFiles.value;
  confirmDeleteFolderId.value = '';
  deleteFolderAlsoFiles.value = false;
  if (!id) return;
  try {
    await api.deleteFolder(id, alsoFiles);
    if (alsoFiles) {
      // 递归删除: 收集所有子文件夹 id + 内部文件 id
      const folderIds = new Set<string>([id]);
      let queue = [id];
      while (queue.length) {
        const next: string[] = [];
        for (const fid of queue) {
          for (const f of folders.value) {
            if (f.parentId === fid && !folderIds.has(f.id)) {
              folderIds.add(f.id);
              next.push(f.id);
            }
          }
        }
        queue = next;
      }
      files.value = files.value.filter(f => !folderIds.has(f.folderId || ''));
      folders.value = folders.value.filter(f => !folderIds.has(f.id));
    } else {
      // 内容回上一级: files.folderId / sub-folders.parentId 提升到被删 folder.parentId
      const deleted = folders.value.find(f => f.id === id);
      const newParentId = deleted ? deleted.parentId : null;
      for (const f of files.value) { if (f.folderId === id) f.folderId = newParentId; }
      for (const f of folders.value) { if (f.parentId === id) f.parentId = newParentId; }
      folders.value = folders.value.filter(f => f.id !== id);
    }
  } catch (e) { console.error('[deleteFolder]', e); }
}

// 跟踪进行中的下载 AbortController, view unmount 时 abort 释放 fetch
let currentDownloadAbort: AbortController | null = null;
async function downloadFolder(f: FolderItem) {
  if (currentDownloadAbort) currentDownloadAbort.abort();
  currentDownloadAbort = new AbortController();
  try { await api.downloadFolder(f, currentDownloadAbort.signal); }
  catch (e: any) {
    if (e?.name !== 'AbortError') console.error('[downloadFolder]', e);
  } finally {
    currentDownloadAbort = null;
  }
}

function enterFolder(f: FolderItem) {
  if (selectMode.value) return; // 选择模式下点击文件夹也只是 toggle 选中 (但暂不支持选文件夹, 直接返回)
  currentFolderId.value = f.id;
  selectedIds.value.clear();
}

function goToBreadcrumb(folderId: string | null) {
  currentFolderId.value = folderId;
  selectedIds.value.clear();
}

// ── 批量移动 ──
async function moveSelectedTo(targetFolderId: string | null) {
  const ids = Array.from(selectedIds.value);
  if (!ids.length) return;
  // 乐观更新
  for (const f of files.value) { if (ids.includes(f.id)) f.folderId = targetFolderId; }
  selectMode.value = false;
  moveTargetOpen.value = false;
  try {
    await api.moveFiles(ids, targetFolderId);
  } catch (e) {
    console.error('[moveSelected] failed:', e);
    load();
  }
}

// 文件夹树扁平化 (用于"移动到..."弹窗显示, indent 按层级)
const folderTree = computed<Array<{ id: string; name: string; depth: number }>>(() => {
  const result: Array<{ id: string; name: string; depth: number }> = [];
  const byParent = new Map<string | null, FolderItem[]>();
  for (const f of folders.value) {
    const arr = byParent.get(f.parentId) || [];
    arr.push(f);
    byParent.set(f.parentId, arr);
  }
  function walk(parentId: string | null, depth: number) {
    const list = (byParent.get(parentId) || []).sort((a, b) => a.name.localeCompare(b.name));
    for (const f of list) {
      result.push({ id: f.id, name: f.name, depth });
      walk(f.id, depth + 1);
    }
  }
  walk(null, 0);
  return result;
});

// ── 拖动文件 / 文件夹 到目标文件夹 / 面包屑 (pointer events, 跟 cardDnd 同 pattern). 距离 > 5px 才算 drag, 否则当 click ──
const DRAG_THRESHOLD = 5;
interface DragState {
  active: boolean;
  fileIds: string[];   // 拖动的文件 ids (单条 / 多选批量)
  folderIds: string[]; // 拖动的文件夹 ids (单条, 不支持多选)
  text: string;
  ghostX: number;
  ghostY: number;
  hoverDropTarget: string | null; // 'root' / folderId / null
}
const dragState = ref<DragState>({ active: false, fileIds: [], folderIds: [], text: '', ghostX: 0, ghostY: 0, hoverDropTarget: null });
let dragStartX = 0, dragStartY = 0, dragPending = false, dragInitId = '', dragInitKind: 'file' | 'folder' = 'file';

function onFilePointerDown(e: PointerEvent, f: FileItem) {
  if (e.button !== 0) return;
  // 避免跟图片预览 / 音频播放 click 冲突: 只在 mouseup-as-click 距离 < threshold 时触发原 click; 这里只记录起点
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragPending = true;
  dragInitId = f.id;
  dragInitKind = 'file';
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

function onFolderPointerDown(e: PointerEvent, folder: FolderItem) {
  if (e.button !== 0) return;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragPending = true;
  dragInitId = folder.id;
  dragInitKind = 'folder';
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

// 文件夹卡片 click: 距离阈值检测防 drag 误触, selectMode 锁路径
function onFolderClick(e: MouseEvent, folder: FolderItem) {
  if (Math.abs(e.clientX - dragStartX) > DRAG_THRESHOLD || Math.abs(e.clientY - dragStartY) > DRAG_THRESHOLD) return;
  if (selectMode.value) return;
  enterFolder(folder);
}

function onPointerMove(e: PointerEvent) {
  const dx = Math.abs(e.clientX - dragStartX);
  const dy = Math.abs(e.clientY - dragStartY);
  if (!dragState.value.active && dragPending && (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD)) {
    // 启动 drag: 区分 file/folder kind
    let fileIds: string[] = [];
    let folderIds: string[] = [];
    if (dragInitKind === 'folder') {
      // 文件夹只能单条拖 (不支持 multi-select folder)
      folderIds = [dragInitId];
    } else {
      // 文件: selectMode + selectedIds 非空 → 拖 selectedIds + dragInitId 并集 (跟主界面 NoteCard 同语义)
      const useBatch = selectMode.value && selectedIds.value.size > 0;
      fileIds = useBatch ? Array.from(new Set([...selectedIds.value, dragInitId])) : [dragInitId];
    }
    const totalCount = fileIds.length + folderIds.length;
    let text: string;
    if (totalCount === 1) {
      if (folderIds.length) text = folders.value.find(x => x.id === folderIds[0])?.name || '文件夹';
      else text = files.value.find(x => x.id === fileIds[0])?.filename || '文件';
    } else {
      text = `${totalCount} 个项目`;
    }
    dragState.value = { active: true, fileIds, folderIds, text, ghostX: e.clientX, ghostY: e.clientY, hoverDropTarget: null };
    // 启动 drag 后立即清掉浏览器自然产生的文字选区, body 加 class 防后续选字
    window.getSelection()?.removeAllRanges();
    document.body.classList.add('resources-dragging');
  }
  if (!dragState.value.active) return;
  e.preventDefault();
  dragState.value.ghostX = e.clientX;
  dragState.value.ghostY = e.clientY;
  // auto-scroll main 当鼠标靠近顶/底缘 60px 内
  const main = document.querySelector('main');
  if (main) {
    const mainRect = main.getBoundingClientRect();
    const margin = 60;
    if (e.clientY < mainRect.top + margin) {
      main.scrollTop -= Math.min(15, mainRect.top + margin - e.clientY);
    } else if (e.clientY > mainRect.bottom - margin) {
      main.scrollTop += Math.min(15, e.clientY - (mainRect.bottom - margin));
    }
  }
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  const dropEl = el?.closest('[data-drop-folder]') as HTMLElement | null;
  let target = dropEl?.getAttribute('data-drop-folder') || null;
  // 文件夹循环校验: 拖动 folderIds 时不能 drop 到自己 / 自己子孙内 (前端校验 hover 视觉 reject, 后端会再校验)
  if (target && target !== 'root' && dragState.value.folderIds.length) {
    for (const sId of dragState.value.folderIds) {
      if (sId === target) { target = null; break; }
      // target 是不是 sId 的子孙
      let cur: string | null = target;
      while (cur) {
        const f: FolderItem | undefined = folders.value.find(x => x.id === cur);
        if (!f) break;
        if (f.parentId === sId) { target = null; break; }
        cur = f.parentId;
      }
      if (!target) break;
    }
  }
  dragState.value.hoverDropTarget = target;
}

async function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  document.body.classList.remove('resources-dragging');
  const state = dragState.value;
  dragPending = false;
  if (!state.active) return;
  const { fileIds, folderIds, hoverDropTarget } = state;
  dragState.value = { active: false, fileIds: [], folderIds: [], text: '', ghostX: 0, ghostY: 0, hoverDropTarget: null };
  if (!hoverDropTarget) return;
  const targetFolderId = hoverDropTarget === 'root' ? null : hoverDropTarget;
  if (targetFolderId === currentFolderId.value && folderIds.length === 0) return; // 拖文件到当前文件夹无意义 (拖文件夹到当前 = 移到当前 = OK)
  // 乐观更新
  for (const f of files.value) { if (fileIds.includes(f.id)) f.folderId = targetFolderId; }
  for (const f of folders.value) { if (folderIds.includes(f.id)) f.parentId = targetFolderId; }
  // 拖走后已经移走的文件不再属于当前目录, 退出 selectMode 让剪切 / 移动按钮不能再操作这批 (watch selectMode → 自动清 selectedIds)
  if (fileIds.length) selectMode.value = false;
  try {
    await api.moveItems({ fileIds, folderIds, targetFolderId });
  } catch (e) {
    console.error('[drag move]', e);
    load();
  }
}

function onRefresh() { load(); }
onMounted(() => {
  load();
  window.addEventListener('quink-refresh', onRefresh);
  window.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  window.removeEventListener('quink-refresh', onRefresh);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  if (currentDownloadAbort) currentDownloadAbort.abort();
});
</script>

<template>
  <div class="px-4 md:px-8 pb-6">
    <!-- Sticky toolbar -->
    <div class="sticky top-0 z-10 -mx-4 md:-mx-8 px-4 md:px-6 pt-[8px] pb-[10px] mb-4 flex items-center justify-between gap-3 border-t border-gray-100 bg-gray-50/80"
      style="box-shadow: 0 1px 3px var(--c-topbar-shadow), 0 1px 0 var(--sb-border)">
      <template v-if="selectMode">
        <p class="text-xs text-primary-dark font-medium">已选 {{ selectedIds.size }} 项</p>
        <div class="flex items-center gap-2">
          <button @click="selectAllFiles" :disabled="filtered.length === 0 || selectedIds.size === filtered.length"
            class="px-3 pt-[0.19rem] pb-[0.31rem] text-xs rounded-lg font-medium bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            全选
          </button>
          <button @click="moveTargetOpen = true" :disabled="!selectedIds.size"
            class="px-3 pt-[0.19rem] pb-[0.31rem] text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:bg-primary/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            移动到...
          </button>
          <button @click="cutSelected" :disabled="!selectedIds.size"
            class="px-3 pt-[0.19rem] pb-[0.31rem] text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:bg-primary/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            剪切
          </button>
          <button @click="confirmBatchDelete = true" :disabled="!selectedIds.size"
            class="px-3 pt-[0.19rem] pb-[0.31rem] text-xs rounded-lg font-medium bg-red-50 text-red-500 hover:bg-red-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            批量删除
          </button>
          <button @click="selectMode = false"
            class="px-3 pt-[0.19rem] pb-[0.31rem] text-xs rounded-lg font-medium bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors">
            退出
          </button>
        </div>
      </template>
      <template v-else>
        <!-- 左侧: 分类筛选 + 视图切换 segmented control -->
        <div class="flex items-center gap-2 flex-wrap">
          <div class="flex gap-1">
            <button v-for="f in filters" :key="f.value" @click="store.fileCategory = f.value as any"
              class="px-3 pt-[0.19rem] pb-[0.31rem] rounded-lg text-xs transition-colors"
              :class="store.fileCategory === f.value ? 'bg-primary-light text-primary-dark font-medium' : 'text-gray-500 hover:bg-gray-100'">
              {{ f.label }}
            </button>
          </div>
          <!-- 视图切换: 两个图标并排, 选中的高亮 (segmented control) -->
          <div class="inline-flex items-center bg-gray-100 rounded-lg p-0.5 gap-0.5">
            <button @click="viewMode = 'grid'" title="网格视图"
              class="p-1 rounded transition-colors"
              :class="viewMode === 'grid' ? 'bg-white text-primary-dark shadow-sm' : 'text-gray-400 hover:text-gray-600'">
              <PhSquaresFour size="0.875rem" weight="fill" />
            </button>
            <button @click="viewMode = 'list'" title="列表视图"
              class="p-1 rounded transition-colors"
              :class="viewMode === 'list' ? 'bg-white text-primary-dark shadow-sm' : 'text-gray-400 hover:text-gray-600'">
              <PhListBullets size="0.875rem" weight="fill" />
            </button>
          </div>
        </div>
        <!-- 右侧: 粘贴 + 清除筛选 + 选择 + 新建文件夹 + 上传 -->
        <div class="flex items-center gap-2">
          <button v-if="cutBuffer" @click="pasteHere"
            :disabled="cutBuffer.sourceFolderId === currentFolderId"
            class="px-3 pt-[0.19rem] pb-[0.31rem] text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:bg-primary/15 transition-colors inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            :title="cutBuffer.sourceFolderId === currentFolderId ? '当前已是剪切来源目录, 切到其他目录可粘贴' : ''">
            粘贴 ({{ cutBuffer.ids.length }})
          </button>
          <button v-if="store.fileDateFrom || store.fileDateTo" @click="clearDateFilter"
            class="text-xs font-medium px-3 pt-[0.19rem] pb-[0.31rem] rounded-lg text-red-600 bg-red-100 hover:bg-red-200 inline-flex items-center gap-1 transition-colors">
            <PhXCircle size="0.875rem" weight="fill" />
            <span>清除时间筛选</span>
          </button>
          <button @click="selectMode = true"
            class="px-3 pt-[0.19rem] pb-[0.31rem] text-xs rounded-lg font-medium bg-gray-200 text-gray-600 hover:bg-gray-300 transition-colors">
            选择
          </button>
          <button @click="startCreateFolder"
            class="px-3 pt-[0.19rem] pb-[0.31rem] text-xs rounded-lg font-medium bg-primary-light text-primary-dark hover:bg-primary/15 transition-colors inline-flex items-center gap-1">
            <PhFolderPlus size="0.875rem" weight="fill" />
            新建文件夹
          </button>
          <button @click="triggerUpload"
            class="px-4 pt-[0.32rem] pb-[0.43rem] bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary-dark transition-colors">
            上传文件
          </button>
        </div>
      </template>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <!-- 子目录里 ".." 上级卡片独立提到列表顶部, 不在 TransitionGroup 内,
           这样空文件夹时 ".." 仍在 "此处暂无文件" 提示上方而非下方 -->
      <div v-if="currentFolderId !== null" class="mb-4">
        <div v-if="viewMode === 'grid'" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          <div :data-drop-folder="parentFolderId || 'root'"
            class="bg-white rounded-xl border overflow-hidden group hover:shadow-md transition-all duration-300 cursor-pointer"
            :class="dragState.active && dragState.hoverDropTarget === (parentFolderId || 'root') ? 'border-primary ring-2 ring-primary' : 'border-gray-200'"
            @click="!selectMode && goToBreadcrumb(parentFolderId)">
            <div class="h-32 bg-gray-50 flex items-center justify-center overflow-hidden">
              <span class="text-3xl font-semibold text-primary-dark/60">..</span>
            </div>
            <div class="px-3 py-2">
              <div class="text-xs font-medium text-gray-700">上级目录</div>
              <div class="flex items-center justify-between mt-1">
                <span class="text-xs text-gray-400">返回</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else :data-drop-folder="parentFolderId || 'root'"
          class="bg-white rounded-lg border px-3 py-2 group hover:shadow-sm transition-all duration-200 cursor-pointer flex items-center gap-3"
          :class="dragState.active && dragState.hoverDropTarget === (parentFolderId || 'root') ? 'border-primary ring-2 ring-primary bg-primary-light/30' : 'border-gray-200'"
          @click="!selectMode && goToBreadcrumb(parentFolderId)">
          <div class="w-6 h-6 shrink-0 flex items-center justify-center text-base font-semibold text-primary-dark/70">..</div>
          <div class="flex-1 min-w-0">
            <div class="text-xs font-medium text-gray-700">上级目录</div>
            <div class="text-[11px] text-gray-400 mt-0.5">返回</div>
          </div>
        </div>
      </div>

      <div v-if="filtered.length === 0 && filteredFolders.length === 0" class="text-center py-16">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhFolder size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">此处暂无文件</p>
        <p class="text-gray-400 text-xs mt-1">点击右上角"上传文件"或"新建文件夹"</p>
      </div>

      <!-- Grid view: folders + files 同 grid (folders 在前, 紧挨, 不另起一行) -->
      <template v-if="viewMode === 'grid'">
        <TransitionGroup tag="div" data-animated-list
          class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4" :css="false" @leave="fadeOutLeave">
          <!-- Folders 先 (跟文件卡片完全同尺寸 h-32 preview + 信息 + actions) -->
          <div v-for="folder in filteredFolders" :key="'folder-' + folder.id" :data-drop-folder="folder.id"
            class="bg-white rounded-xl border overflow-hidden group hover:shadow-md transition-all duration-300 cursor-pointer"
            :class="dragState.active && dragState.hoverDropTarget === folder.id ? 'border-primary ring-2 ring-primary' : 'border-gray-200'"
            @click="onFolderClick($event, folder)" @pointerdown="onFolderPointerDown($event, folder)">
            <div class="h-32 bg-gray-50 flex items-center justify-center overflow-hidden">
              <PhFolderSimple size="3rem" weight="fill" class="text-primary-dark/70" />
            </div>
            <div class="px-3 py-2">
              <div class="text-xs font-medium text-gray-700 truncate" :title="folder.name">{{ folder.name }}</div>
              <div class="flex items-center justify-between mt-1">
                <span class="text-xs text-gray-400">文件夹</span>
              </div>
            </div>
            <div v-if="!selectMode" class="flex items-center border-t border-gray-50 opacity-0 group-hover:opacity-100 transition-opacity">
              <button v-if="hasSearchQuery" @click.stop="openFolderLocation(folder)"
                class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-primary">所在位置</button>
              <button @click.stop="downloadFolder(folder)"
                class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-primary"
                :class="hasSearchQuery ? 'border-l border-gray-50' : ''">下载</button>
              <button @click.stop="startRenameFolder(folder)"
                class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-primary border-l border-gray-50">重命名</button>
              <button @click.stop="confirmDeleteFolderId = folder.id"
                class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-red-50 hover:text-red-500 border-l border-gray-50">删除</button>
            </div>
          </div>

          <!-- Files 后 (跟 folders 同 grid 内, 紧挨, 不另起一行) -->
          <div v-for="f in filtered" :key="f.id"
            class="bg-white rounded-xl border overflow-hidden group hover:shadow-md transition-all duration-300 cursor-default"
            :class="selectedIds.has(f.id) ? 'border-primary ring-2 ring-primary' : 'border-gray-200'"
            @click="onCardClick($event, f)" @pointerdown="onFilePointerDown($event, f)">
            <div class="h-32 bg-gray-50 flex items-center justify-center overflow-hidden relative">
              <div v-if="selectMode" class="absolute top-2 left-2 z-10 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 transition-all"
                :class="selectedIds.has(f.id) ? 'bg-primary border-primary' : 'border-gray-400 bg-white/80'">
                <svg v-if="selectedIds.has(f.id)" class="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12l5 5L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </div>
              <img v-if="isImage(f)" :src="resolveFileUrl(f.url)" :alt="f.filename"
                class="w-full h-full object-cover" :class="!selectMode ? 'cursor-zoom-in' : ''" />
              <div v-else-if="isAudio(f)" class="px-3 w-full" @click.stop>
                <AudioPlayer :src="resolveFileUrl(f.url)" />
              </div>
              <div v-else class="text-center">
                <div class="flex justify-center mb-1 text-gray-400">
                  <PhFilePdf v-if="f.mimeType.includes('pdf')" size="2.25rem" weight="fill" />
                  <PhFileText v-else-if="f.mimeType.includes('json')" size="2.25rem" weight="fill" />
                  <PhFileZip v-else-if="f.mimeType.includes('zip')" size="2.25rem" weight="fill" />
                  <PhFile v-else size="2.25rem" weight="fill" />
                </div>
                <div class="text-xs text-gray-400">{{ f.mimeType.split('/')[1] }}</div>
              </div>
            </div>
            <div class="px-3 py-2">
              <div class="text-xs font-medium text-gray-700 truncate" :title="f.filename">{{ f.filename }}</div>
              <div class="flex items-center justify-between mt-1">
                <span class="text-xs text-gray-400">{{ formatSize(f.size) }}</span>
                <span class="text-xs text-gray-400">{{ formatDate(f.createdAt) }}</span>
              </div>
            </div>
            <div v-if="!selectMode" class="flex items-center border-t border-gray-50 opacity-0 group-hover:opacity-100 transition-opacity">
              <button v-if="hasSearchQuery" @click.stop="openFileLocation(f)"
                class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-primary">所在位置</button>
              <a :href="resolveFileUrl(f.url)" target="_blank" download @click.stop
                class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-primary"
                :class="hasSearchQuery ? 'border-l border-gray-50' : ''">下载</a>
              <button @click.stop="startRename(f)"
                class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-primary border-l border-gray-50">重命名</button>
              <button @click.stop="confirmDeleteId = f.id"
                class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-red-50 hover:text-red-500 border-l border-gray-50">删除</button>
            </div>
          </div>
        </TransitionGroup>
      </template>

      <!-- List view -->
      <template v-else>
        <!-- folders + files 同 list (folders 在前, 紧挨, 不另起一行). ".." 上级卡片已独立提到列表顶部上方 -->
        <TransitionGroup tag="div" data-animated-list
          class="flex flex-col gap-1" :css="false" @leave="fadeOutLeave">
          <!-- Folders 先 -->
          <div v-for="folder in filteredFolders" :key="'folder-' + folder.id" :data-drop-folder="folder.id"
            class="bg-white rounded-lg border px-3 py-2 group hover:shadow-sm transition-all duration-200 cursor-pointer flex items-center gap-3"
            :class="dragState.active && dragState.hoverDropTarget === folder.id ? 'border-primary ring-2 ring-primary bg-primary-light/30' : 'border-gray-200'"
            @click="onFolderClick($event, folder)" @pointerdown="onFolderPointerDown($event, folder)">
            <PhFolderSimple size="1.5rem" weight="fill" class="text-primary-dark shrink-0" />
            <div class="flex-1 min-w-0">
              <div class="text-xs font-medium text-gray-700 truncate" :title="folder.name">{{ folder.name }}</div>
              <div class="text-[11px] text-gray-400 mt-0.5">文件夹</div>
            </div>
            <div class="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <button v-if="hasSearchQuery" @click.stop="openFolderLocation(folder)"
                class="px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-primary rounded">所在位置</button>
              <button @click.stop="downloadFolder(folder)"
                class="px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-primary rounded">下载</button>
              <button @click.stop="startRenameFolder(folder)"
                class="px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-primary rounded">重命名</button>
              <button @click.stop="confirmDeleteFolderId = folder.id"
                class="px-2 py-1 text-[11px] text-gray-500 hover:bg-red-50 hover:text-red-500 rounded">删除</button>
            </div>
          </div>
          <!-- Files 后 -->
          <div v-for="f in filtered" :key="f.id"
            class="bg-white rounded-lg border px-3 py-2 group hover:shadow-sm transition-all duration-200 cursor-default flex items-center gap-3"
            :class="selectedIds.has(f.id) ? 'border-primary ring-2 ring-primary' : 'border-gray-200'"
            @click="onCardClick($event, f)" @pointerdown="onFilePointerDown($event, f)">
            <div v-if="selectMode" class="w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 transition-all"
              :class="selectedIds.has(f.id) ? 'bg-primary border-primary' : 'border-gray-400 bg-white'">
              <svg v-if="selectedIds.has(f.id)" class="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none">
                <path d="M5 12l5 5L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </div>
            <div class="w-9 h-9 shrink-0 bg-gray-50 rounded flex items-center justify-center overflow-hidden">
              <img v-if="isImage(f)" :src="resolveFileUrl(f.url)" :alt="f.filename"
                class="w-full h-full object-cover" :class="!selectMode ? 'cursor-zoom-in' : ''" />
              <PhFilePdf v-else-if="f.mimeType.includes('pdf')" size="1.25rem" weight="fill" class="text-gray-400" />
              <PhFileText v-else-if="f.mimeType.includes('json')" size="1.25rem" weight="fill" class="text-gray-400" />
              <PhFileZip v-else-if="f.mimeType.includes('zip')" size="1.25rem" weight="fill" class="text-gray-400" />
              <PhFile v-else size="1.25rem" weight="fill" class="text-gray-400" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-xs font-medium text-gray-700 truncate" :title="f.filename">{{ f.filename }}</div>
              <div class="text-[11px] text-gray-400 mt-0.5">{{ formatSize(f.size) }} · {{ formatDate(f.createdAt) }}</div>
            </div>
            <div v-if="isAudio(f)" class="w-48 shrink-0 mx-auto" @click.stop>
              <AudioPlayer :src="resolveFileUrl(f.url)" hideBars />
            </div>
            <div v-if="!selectMode" class="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <button v-if="hasSearchQuery" @click.stop="openFileLocation(f)"
                class="px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-primary rounded">所在位置</button>
              <a :href="resolveFileUrl(f.url)" target="_blank" download @click.stop
                class="px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-primary rounded">下载</a>
              <button @click.stop="startRename(f)"
                class="px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-primary rounded">重命名</button>
              <button @click.stop="confirmDeleteId = f.id"
                class="px-2 py-1 text-[11px] text-gray-500 hover:bg-red-50 hover:text-red-500 rounded">删除</button>
            </div>
          </div>
        </TransitionGroup>
      </template>
    </template>
  </div>

  <!-- 文件重命名弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="renameTarget" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="renameTarget = null" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-80">
          <p class="text-sm text-gray-700 mb-1">重命名文件</p>
          <p class="text-xs text-gray-400 mb-3">引用这个文件的笔记里链接显示名会同步更新</p>
          <input ref="renameInput" v-model="renameValue"
            @keydown.enter="doRename" @keydown.esc="renameTarget = null"
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary mb-4" />
          <div class="flex gap-2 justify-end">
            <button @click="renameTarget = null"
              class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doRename"
              class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg text-white font-medium bg-primary hover:bg-primary-dark">保存</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 文件删除确认 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmDeleteId" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmDeleteId = ''" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">删除文件</p>
          <p class="text-xs text-gray-400 mb-4">删除后不可恢复</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmDeleteId = ''" class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doDeleteFile" class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 批量删除确认 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmBatchDelete" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmBatchDelete = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">批量删除</p>
          <p class="text-xs text-gray-400 mb-4">将永久删除选中的 {{ selectedIds.size }} 个文件，不可恢复</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmBatchDelete = false" class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doBatchDelete" class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 新建文件夹弹窗 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="createFolderOpen" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="createFolderOpen = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-80">
          <p class="text-sm text-gray-700 mb-3">新建文件夹</p>
          <input ref="createFolderInput" v-model="createFolderName" placeholder="文件夹名"
            @keydown.enter="doCreateFolder" @keydown.esc="createFolderOpen = false"
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary mb-4" />
          <div class="flex gap-2 justify-end">
            <button @click="createFolderOpen = false"
              class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doCreateFolder" :disabled="!createFolderName.trim()"
              class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg text-white font-medium bg-primary hover:bg-primary-dark disabled:opacity-40">创建</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 文件夹重命名 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="renameFolderTarget" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="renameFolderTarget = null" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-80">
          <p class="text-sm text-gray-700 mb-3">重命名文件夹</p>
          <input ref="renameFolderInput" v-model="renameFolderValue"
            @keydown.enter="doRenameFolder" @keydown.esc="renameFolderTarget = null"
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary mb-4" />
          <div class="flex gap-2 justify-end">
            <button @click="renameFolderTarget = null"
              class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doRenameFolder"
              class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg text-white font-medium bg-primary hover:bg-primary-dark">保存</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 文件夹删除确认 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="confirmDeleteFolderId" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmDeleteFolderId = ''" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-80">
          <p class="text-sm text-gray-700 mb-1 text-center">删除文件夹</p>
          <p class="text-xs text-gray-400 mb-4 text-center">
            {{ deleteFolderAlsoFiles ? '将永久删除文件夹及其所有内容' : '文件夹内的文件会回到上级目录' }}
          </p>
          <label class="flex items-center gap-2 mb-4 cursor-pointer select-none text-xs text-gray-600">
            <input type="checkbox" v-model="deleteFolderAlsoFiles" class="w-3.5 h-3.5 accent-red-500" />
            <span>同时删除文件夹内所有文件和子文件夹</span>
          </label>
          <div class="flex gap-2 justify-center">
            <button @click="confirmDeleteFolderId = ''" class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doDeleteFolder" class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 拖动 ghost (fixed 跟鼠标移动, 显示拖动的文件名 / 数量) -->
  <div v-if="dragState.active" class="fixed pointer-events-none z-[9999] bg-white px-3 py-2 rounded-lg shadow-lg border border-primary text-xs text-gray-700 font-medium"
    :style="{ left: dragState.ghostX + 12 + 'px', top: dragState.ghostY + 12 + 'px' }">
    {{ dragState.text }}
  </div>

  <!-- 移动到... 弹窗 (展开整个文件夹树) -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="moveTargetOpen" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="moveTargetOpen = false" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 max-h-[70vh] flex flex-col">
          <p class="text-sm text-gray-700 mb-3">移动 {{ selectedIds.size }} 个文件到...</p>
          <div class="flex-1 overflow-y-auto -mx-2 border border-gray-100 rounded-lg p-1 max-h-80">
            <button @click="moveSelectedTo(null)" :disabled="currentFolderId === null"
              class="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 inline-flex items-center gap-2 text-xs text-gray-600 disabled:opacity-40 disabled:cursor-not-allowed">
              <PhHouse size="0.875rem" weight="fill" />
              根目录{{ currentFolderId === null ? ' (当前位置)' : '' }}
            </button>
            <button v-for="f in folderTree" :key="f.id" @click="moveSelectedTo(f.id)"
              :disabled="f.id === currentFolderId"
              class="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 inline-flex items-center gap-2 text-xs text-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
              :style="{ paddingLeft: 12 + f.depth * 16 + 'px' }">
              <PhFolderSimple size="0.875rem" weight="fill" />
              {{ f.name }}{{ f.id === currentFolderId ? ' (当前位置)' : '' }}
            </button>
          </div>
          <div class="flex justify-end mt-3">
            <button @click="moveTargetOpen = false"
              class="px-4 pt-[0.32rem] pb-[0.43rem] text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
