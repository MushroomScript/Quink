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
onMounted(() => { load(); window.addEventListener('quink-refresh', onRefresh); });
onUnmounted(() => { window.removeEventListener('quink-refresh', onRefresh); });
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
      <p class="text-gray-400 text-xs mt-1">在灵感编辑器中上传文件，或点击上方按钮</p>
    </div>

    <!-- File grid -->
    <div v-else class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      <div v-for="f in filtered" :key="f.id"
        class="bg-white rounded-xl border border-gray-200 overflow-hidden group hover:shadow-md transition-shadow">
        <!-- Preview area -->
        <div class="h-32 bg-gray-50 flex items-center justify-center overflow-hidden">
          <!-- Image preview -->
          <img v-if="isImage(f)" :src="f.url" :alt="f.filename" class="w-full h-full object-cover" />
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
