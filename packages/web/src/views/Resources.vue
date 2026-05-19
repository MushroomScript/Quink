<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide } from 'vue';
import { api, isLoggedIn } from '@/api';
import {
  PhFolder,
  PhMusicNote,
  PhFilePdf,
  PhFileText,
  PhFileZip,
  PhFile,
  PhX,
  PhDownloadSimple,
  PhCaretLeft,
  PhCaretRight,
} from '@phosphor-icons/vue';

interface FileItem {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  category: string;
  size: number;
  createdAt: string;
}

const files = ref<FileItem[]>([]);
const pageCount = computed(() => files.value.length);
provide('pageCount', pageCount);
const loading = ref(true);
const filter = ref('all');
const confirmDeleteId = ref('');
const previewImage = ref<FileItem | null>(null);
const zoom = ref(1);
const offset = ref({ x: 0, y: 0 });
const dragging = ref(false);
const imageFiles = computed(() => filtered.value.filter(isImage));
// 用于区分"点击关闭"和"拖动后释放"：拖动过就别误关
let dragStartX = 0;
let dragStartY = 0;
let dragMoved = false;

function resetView() { zoom.value = 1; offset.value = { x: 0, y: 0 }; }

function openPreview(f: FileItem) {
  previewImage.value = f;
  resetView();
}

function closePreview() {
  previewImage.value = null;
  resetView();
}

function navigateImage(delta: number) {
  if (!previewImage.value || imageFiles.value.length === 0) return;
  const id = previewImage.value.id;
  const idx = imageFiles.value.findIndex(x => x.id === id);
  if (idx < 0) return;
  const n = imageFiles.value.length;
  // 取模兼容负数：往左到 -1 自动跳到末尾
  const newIdx = ((idx + delta) % n + n) % n;
  previewImage.value = imageFiles.value[newIdx];
  resetView();
}

function handleWheel(e: WheelEvent) {
  if (!previewImage.value) return;
  e.preventDefault();
  const step = 0.2;
  const newZoom = Math.max(0.5, Math.min(4, zoom.value + (-Math.sign(e.deltaY) * step)));
  // 缩小到 1x 及以下时重置平移，避免图片飞到边角
  if (newZoom <= 1) offset.value = { x: 0, y: 0 };
  zoom.value = newZoom;
}

function handleImageMouseDown(e: MouseEvent) {
  if (zoom.value <= 1) return; // 只在放大态下启用拖动
  e.preventDefault();
  dragging.value = true;
  dragMoved = false;
  dragStartX = e.clientX - offset.value.x;
  dragStartY = e.clientY - offset.value.y;
  window.addEventListener('mousemove', handleImageMouseMove);
  window.addEventListener('mouseup', handleImageMouseUp);
}

function handleImageMouseMove(e: MouseEvent) {
  if (!dragging.value) return;
  const nx = e.clientX - dragStartX;
  const ny = e.clientY - dragStartY;
  // 3px 阈值才算"拖动"：避免抖动误判
  if (Math.abs(nx - offset.value.x) > 3 || Math.abs(ny - offset.value.y) > 3) dragMoved = true;
  offset.value = { x: nx, y: ny };
}

function handleImageMouseUp() {
  dragging.value = false;
  window.removeEventListener('mousemove', handleImageMouseMove);
  window.removeEventListener('mouseup', handleImageMouseUp);
}

function handleImageClick() {
  // 刚拖完的释放也会触发 click：吞掉这次
  if (dragMoved) { dragMoved = false; return; }
  closePreview();
}

function handlePreviewKeydown(e: KeyboardEvent) {
  if (!previewImage.value) return;
  if (e.key === 'Escape') closePreview();
  else if (e.key === 'ArrowLeft') navigateImage(-1);
  else if (e.key === 'ArrowRight') navigateImage(1);
}

const filters = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'audio', label: '音频' },
  { value: 'document', label: '文档' },
];

const filtered = computed(() => {
  if (filter.value === 'all') return files.value;
  return files.value.filter(f => f.category === filter.value);
});

async function load() {
  if (!isLoggedIn()) return;
  loading.value = true;
  try {
    const res = await api.getFiles();
    files.value = res.data;
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

async function doDeleteFile() {
  const id = confirmDeleteId.value;
  confirmDeleteId.value = '';
  if (!id) return;
  try { await api.deleteFile(id); files.value = files.value.filter(f => f.id !== id); } catch {}
}

function triggerUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,audio/*,.pdf,.txt,.md,.json,.zip,.doc,.docx,.xls,.xlsx';
  input.multiple = true;
  input.onchange = async () => {
    if (!input.files) return;
    for (const file of Array.from(input.files)) {
      try { await api.uploadFile(file); } catch {}
    }
    load();
  };
  input.click();
}

function onRefresh() { load(); }
onMounted(() => {
  load();
  window.addEventListener('quink-refresh', onRefresh);
  window.addEventListener('keydown', handlePreviewKeydown);
});
onUnmounted(() => {
  window.removeEventListener('quink-refresh', onRefresh);
  window.removeEventListener('keydown', handlePreviewKeydown);
});
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <!-- Filter + upload -->
    <div class="flex items-center justify-between mb-6">
      <div class="flex gap-1">
        <button v-for="f in filters" :key="f.value" @click="filter = f.value"
          class="px-3 py-1.5 rounded-lg text-xs transition-colors"
          :class="filter === f.value ? 'bg-primary-light text-primary-dark font-medium' : 'text-gray-500 hover:bg-gray-100'">
          {{ f.label }}
        </button>
      </div>
      <button @click="triggerUpload"
        class="px-4 py-1.5 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary-dark transition-colors">
        上传文件
      </button>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="filtered.length === 0" class="text-center py-16">
      <div class="mb-3 flex justify-center text-gray-300">
        <PhFolder size="3rem" weight="fill" />
      </div>
      <p class="text-gray-500 text-sm">暂无文件</p>
      <p class="text-gray-400 text-xs mt-1">在编辑器中上传文件，或点击右上角上传文件按钮</p>
    </div>

    <!-- File grid -->
    <div v-else class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      <div v-for="f in filtered" :key="f.id"
        class="bg-white rounded-xl border border-gray-200 overflow-hidden group hover:shadow-md transition-shadow">
        <!-- Preview area -->
        <div class="h-32 bg-gray-50 flex items-center justify-center overflow-hidden">
          <!-- Image preview -->
          <img v-if="isImage(f)" :src="f.url" :alt="f.filename" @click="openPreview(f)"
            class="w-full h-full object-cover cursor-zoom-in" />
          <!-- Audio player -->
          <div v-else-if="isAudio(f)" class="px-3 w-full">
            <div class="flex justify-center mb-2 text-gray-400">
              <PhMusicNote size="1.75rem" weight="fill" />
            </div>
            <audio :src="f.url" controls class="w-full h-8" style="min-width: 0;" />
          </div>
          <!-- Document icon -->
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

        <!-- Info -->
        <div class="px-3 py-2">
          <div class="text-xs font-medium text-gray-700 truncate" :title="f.filename">{{ f.filename }}</div>
          <div class="flex items-center justify-between mt-1">
            <span class="text-xs text-gray-400">{{ formatSize(f.size) }}</span>
            <span class="text-xs text-gray-400">{{ formatDate(f.createdAt) }}</span>
          </div>
        </div>

        <!-- Actions -->
        <div class="flex items-center border-t border-gray-50 opacity-0 group-hover:opacity-100 transition-opacity">
          <a :href="f.url" target="_blank" download
            class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-primary">
            下载
          </a>
          <button @click="confirmDeleteId = f.id"
            class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-red-50 hover:text-red-500">
            删除
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 图片预览弹窗 -->
  <Teleport to="body">
    <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0"
      leave-active-class="transition duration-100 ease-in" leave-to-class="opacity-0">
      <div v-if="previewImage" class="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 cursor-zoom-out"
        @click="closePreview" @wheel="handleWheel">
        <img :src="previewImage.url" :alt="previewImage.filename" draggable="false"
          @mousedown="handleImageMouseDown" @click.stop="handleImageClick"
          :style="{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transition: dragging ? 'none' : 'transform 0.15s ease',
            cursor: dragging ? 'grabbing' : (zoom > 1 ? 'grab' : 'zoom-out'),
          }"
          class="max-w-[92vw] max-h-[88vh] object-contain rounded-md shadow-2xl select-none" />
        <!-- 上一张/下一张（只在图片 > 1 张时显示） -->
        <button v-if="imageFiles.length > 1" @click.stop="navigateImage(-1)"
          class="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="上一张 (←)">
          <PhCaretLeft size="1.25rem" weight="bold" />
        </button>
        <button v-if="imageFiles.length > 1" @click.stop="navigateImage(1)"
          class="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="下一张 (→)">
          <PhCaretRight size="1.25rem" weight="bold" />
        </button>
        <!-- 关闭 -->
        <button @click.stop="closePreview"
          class="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="关闭 (Esc)">
          <PhX size="1.125rem" weight="bold" />
        </button>
        <!-- 下载 -->
        <a :href="previewImage.url" target="_blank" download @click.stop
          class="absolute top-4 right-16 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="下载">
          <PhDownloadSimple size="1.125rem" weight="fill" />
        </a>
        <!-- 底部：文件名 + 缩放比例 -->
        <div class="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-xs bg-black/40 px-3 py-1 rounded-full max-w-[80vw] truncate inline-flex items-center gap-2">
          <span class="truncate">{{ previewImage.filename }}</span>
          <span v-if="zoom !== 1" class="opacity-70 tabular-nums shrink-0">{{ Math.round(zoom * 100) }}%</span>
        </div>
      </div>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <div v-if="confirmDeleteId" class="fixed inset-0 z-[200] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" @click="confirmDeleteId = ''" />
      <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
        <p class="text-sm text-gray-700 mb-1">删除文件</p>
        <p class="text-xs text-gray-400 mb-4">删除后不可恢复</p>
        <div class="flex gap-2 justify-center">
          <button @click="confirmDeleteId = ''" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
          <button @click="doDeleteFile" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
