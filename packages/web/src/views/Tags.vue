<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api, isLoggedIn } from '@/api';
import { useNotesStore } from '@/stores/notes';
import { useRouter } from 'vue-router';

const store = useNotesStore();
const router = useRouter();
const allTags = ref<string[]>([]);
const loading = ref(true);
const editingTag = ref('');
const newName = ref('');
const confirmDelete = ref('');

async function load() {
  if (!isLoggedIn()) return;
  loading.value = true;
  try {
    const res = await api.getTags();
    allTags.value = res.data;
  } catch {}
  loading.value = false;
}

function filterByTag(tag: string) {
  store.searchQuery = '';
  store.filterType = '';
  router.push('/');
  // Use TopBar search with tag filter
  setTimeout(() => {
    store.fetchNotes({ tag });
  }, 100);
}

// 重命名标签：更新所有笔记里的这个标签
async function renameTag() {
  if (!editingTag.value || !newName.value.trim()) return;
  const old = editingTag.value;
  const renamed = newName.value.trim();
  try {
    // 获取所有包含该标签的笔记
    const res = await api.getNotes({ tag: old, limit: '1000' });
    for (const note of res.data) {
      const tags = (note.tags as string[]).map(t => t === old ? renamed : t);
      await api.updateNote(note.id, { tags } as any);
    }
    editingTag.value = '';
    newName.value = '';
    await load();
  } catch {}
}

async function deleteTag(tag: string) {
  if (confirmDelete.value !== tag) {
    confirmDelete.value = tag;
    setTimeout(() => (confirmDelete.value = ''), 3000);
    return;
  }
  try {
    const res = await api.getNotes({ tag, limit: '1000' });
    for (const note of res.data) {
      const tags = (note.tags as string[]).filter(t => t !== tag);
      await api.updateNote(note.id, { tags } as any);
    }
    confirmDelete.value = '';
    await load();
  } catch {}
}

onMounted(load);
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="allTags.length === 0" class="text-center py-16">
      <div class="text-4xl mb-3">🏷️</div>
      <p class="text-gray-500 text-sm">还没有任何标签</p>
      <p class="text-gray-400 text-xs mt-1">笔记保存后 AI 会自动生成标签</p>
    </div>

    <div v-else class="flex flex-wrap gap-3">
      <div v-for="tag in allTags" :key="tag"
        class="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3 group hover:shadow-sm transition-shadow">
        <span class="text-sm cursor-pointer hover:text-primary" @click="filterByTag(tag)">#{{ tag }}</span>
        <div class="flex gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <button @click="editingTag = tag; newName = tag" class="text-xs text-gray-400 hover:text-gray-600">改名</button>
          <button @click="deleteTag(tag)" class="text-xs"
            :class="confirmDelete === tag ? 'text-red-500 font-medium' : 'text-gray-400 hover:text-red-500'">
            {{ confirmDelete === tag ? '确认?' : '删除' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Rename dialog -->
    <div v-if="editingTag" class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" @click="editingTag = ''" />
      <div class="relative bg-white rounded-xl shadow-xl p-6 w-80 space-y-4">
        <h3 class="text-sm font-medium text-gray-800">重命名标签</h3>
        <p class="text-xs text-gray-400">将 #{{ editingTag }} 重命名为：</p>
        <input v-model="newName" @keydown.enter="renameTag" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary" />
        <div class="flex gap-2">
          <button @click="renameTag" class="px-4 py-1.5 text-white text-xs font-medium rounded-lg" style="background: rgb(var(--c-accent))">确定</button>
          <button @click="editingTag = ''" class="px-4 py-1.5 text-xs text-gray-500 hover:bg-gray-100 rounded-lg">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>
