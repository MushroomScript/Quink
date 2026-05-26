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

const store = useNotesStore();
import {
  PhFolder,
  PhFilePdf,
  PhFileText,
  PhFileZip,
  PhFile,
  PhXCircle,
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
const confirmDeleteId = ref('');
// 重命名: target 持有原文件 reference + 当前 input 值
const renameTarget = ref<FileItem | null>(null);
const renameValue = ref('');
useEscToClose(confirmDeleteId, '');
useEscToClose(renameTarget, null);
const renameInput = ref<HTMLInputElement | null>(null);
const imageFiles = computed(() => filtered.value.filter(isImage));
const { open: openImagePreview } = useImagePreview();

// 点击 grid 内某张图 → 打开全屏预览（缩放 / 拖动 / 上下张切换 / 下载 / Esc 关闭 都由 ImagePreview 组件统一处理）
function onImageClick(f: FileItem) {
  // 文件 url 现在存裸名,预览组件拿到的要拼成绝对路径
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

const filtered = computed(() => {
  let list = store.fileCategory === 'all' ? files.value : files.value.filter(f => f.category === store.fileCategory);
  // TopBar 搜索框的 store.searchQuery 在资源页用作文件名过滤
  // pinyinMatch 支持拼音搜索: 输入 yyx/yuyinxiaoxi 都能命中"语音消息.mp3"
  const q = store.searchQuery?.trim();
  if (q) list = list.filter(f => pinyinMatch(f.filename, q));
  // 日期范围过滤(TopBar 筛选面板)
  if (store.fileDateFrom) list = list.filter(f => f.createdAt.slice(0, 10) >= store.fileDateFrom);
  if (store.fileDateTo) list = list.filter(f => f.createdAt.slice(0, 10) <= store.fileDateTo);
  return list;
});

// 数据变更前主动 snapshot 所有卡片位置，避免 onLeave 钩子里拿到的是 v-if 切换后的错位坐标
watch(() => filtered.value.length, () => snapshotCards(), { flush: 'sync' });

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

function startRename(f: FileItem) {
  renameTarget.value = f;
  renameValue.value = f.filename;
  // 弹窗渲染后 focus + 选中(不带扩展名只选中前面的名字部分让用户直接覆盖输入)
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
  if (!name || name === target.filename) {
    renameTarget.value = null;
    return;
  }
  try {
    await api.renameFile(target.id, name);
    files.value = files.value.map(f => f.id === target.id ? { ...f, filename: name } : f);
  } catch (e) {
    console.error('[Resources] rename failed', e);
  }
  renameTarget.value = null;
}

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

function clearDateFilter() {
  store.fileDateFrom = '';
  store.fileDateTo = '';
}

function onRefresh() { load(); }
onMounted(() => {
  load();
  window.addEventListener('quink-refresh', onRefresh);
});
onUnmounted(() => {
  window.removeEventListener('quink-refresh', onRefresh);
});
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <!-- Filter + upload -->
    <div class="flex items-center justify-between mb-6">
      <div class="flex gap-1">
        <button v-for="f in filters" :key="f.value" @click="store.fileCategory = f.value as any"
          class="px-3 py-1.5 rounded-lg text-xs transition-colors"
          :class="store.fileCategory === f.value ? 'bg-primary-light text-primary-dark font-medium' : 'text-gray-500 hover:bg-gray-100'">
          {{ f.label }}
        </button>
      </div>
      <div class="flex items-center gap-2">
        <button v-if="store.fileDateFrom || store.fileDateTo" @click="clearDateFilter"
          class="text-xs font-medium px-3 py-1.5 rounded-lg text-red-600 bg-red-100 hover:bg-red-200 inline-flex items-center gap-1 transition-colors">
          <PhXCircle size="0.875rem" weight="fill" />
          <span>清除时间筛选</span>
        </button>
        <button @click="triggerUpload"
          class="px-4 py-1.5 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary-dark transition-colors">
          上传文件
        </button>
      </div>
    </div>

    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <div v-if="filtered.length === 0" class="text-center py-16">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhFolder size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">暂无文件</p>
        <p class="text-gray-400 text-xs mt-1">在编辑器中上传文件，或点击右上角上传文件按钮</p>
      </div>

      <!-- File grid -->
      <TransitionGroup tag="div" data-animated-list class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4" :css="false" @leave="fadeOutLeave">
        <div v-for="f in filtered" :key="f.id"
          class="bg-white rounded-xl border border-gray-200 overflow-hidden group hover:shadow-md transition-all duration-300">
        <!-- Preview area -->
        <div class="h-32 bg-gray-50 flex items-center justify-center overflow-hidden">
          <!-- Image preview;url 是裸名,resolveFileUrl 拼 /api/uploads/ 前缀 -->
          <img v-if="isImage(f)" :src="resolveFileUrl(f.url)" :alt="f.filename" @click="onImageClick(f)"
            class="w-full h-full object-cover cursor-zoom-in" />
          <!-- Audio player: 自定义紧凑播放器, 内含顶部音符/跳动条 visual + 单行播放/进度/时间/音量 -->
          <div v-else-if="isAudio(f)" class="px-3 w-full">
            <AudioPlayer :src="resolveFileUrl(f.url)" />
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

        <!-- Actions: 下载 / 重命名 / 删除,中间 border-l 视觉分隔 -->
        <div class="flex items-center border-t border-gray-50 opacity-0 group-hover:opacity-100 transition-opacity">
          <a :href="resolveFileUrl(f.url)" target="_blank" download
            class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-primary">
            下载
          </a>
          <button @click="startRename(f)"
            class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-primary border-l border-gray-50">
            重命名
          </button>
          <button @click="confirmDeleteId = f.id"
            class="flex-1 text-center py-1.5 text-xs text-gray-500 hover:bg-red-50 hover:text-red-500 border-l border-gray-50">
            删除
          </button>
        </div>
        </div>
      </TransitionGroup>
    </template>
  </div>

  <!-- 重命名弹窗: 标准 modal 风格,Enter 提交 / Esc 取消 / 点 mask 取消 -->
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="renameTarget" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="renameTarget = null" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-80">
          <p class="text-sm text-gray-700 mb-1">重命名文件</p>
          <p class="text-xs text-gray-400 mb-3">引用这个文件的笔记里链接显示名会同步更新</p>
          <input ref="renameInput" v-model="renameValue"
            @keydown.enter="doRename"
            @keydown.esc="renameTarget = null"
            class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary mb-4" />
          <div class="flex gap-2 justify-end">
            <button @click="renameTarget = null"
              class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doRename"
              class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-primary hover:bg-primary-dark">保存</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <Transition name="modal">
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
    </Transition>
  </Teleport>
</template>
