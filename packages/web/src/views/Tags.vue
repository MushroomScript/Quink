<script setup lang="ts">
import { ref, computed, onMounted, provide } from 'vue';
import { api, isLoggedIn } from '@/api';
import { useNotesStore } from '@/stores/notes';
import { useRouter } from 'vue-router';
import { PhTag, PhPencilSimple, PhX } from '@phosphor-icons/vue';

const store = useNotesStore();
const router = useRouter();
const allTags = ref<string[]>([]);
const pageCount = computed(() => allTags.value.length);
provide('pageCount', pageCount);
const loading = ref(true);
const editingTag = ref('');
const newName = ref('');
const confirmDeleteTag = ref('');

async function load() {
  if (!isLoggedIn()) return;
  loading.value = true;
  try { allTags.value = (await api.getTags()).data; } catch {}
  loading.value = false;
}

function filterByTag(tag: string) {
  router.push({ path: '/', query: { tag } });
}

async function renameTag() {
  if (!editingTag.value || !newName.value.trim()) return;
  const old = editingTag.value;
  const renamed = newName.value.trim();
  try {
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

async function doDeleteTag() {
  const tag = confirmDeleteTag.value;
  confirmDeleteTag.value = '';
  if (!tag) return;
  try {
    const res = await api.getNotes({ tag, limit: '1000' });
    for (const note of res.data) {
      const tags = (note.tags as string[]).filter(t => t !== tag);
      await api.updateNote(note.id, { tags } as any);
    }
    await load();
  } catch {}
}

onMounted(load);
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <div v-if="loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="allTags.length === 0" class="text-center py-16">
      <div class="mb-3 flex justify-center text-gray-300">
        <PhTag size="3rem" weight="fill" />
      </div>
      <p class="text-gray-500 text-sm">还没有任何标签</p>
      <p class="text-gray-400 text-xs mt-1">笔记保存后 AI 会自动生成标签</p>
    </div>

    <div v-else class="flex flex-wrap gap-2">
      <div v-for="tag in allTags" :key="tag"
        class="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-full group transition-colors"
        style="background: rgb(var(--c-accent-light)); color: rgb(var(--c-accent-dark))">
        <span class="text-sm cursor-pointer hover:opacity-70" @click="filterByTag(tag)">#{{ tag }}</span>
        <div class="flex gap-0.5 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <button @click="editingTag = tag; newName = tag" class="p-1 rounded-full hover:bg-white/50" title="重命名">
            <PhPencilSimple size="0.75rem" weight="fill" />
          </button>
          <button @click="confirmDeleteTag = tag" class="p-1 rounded-full hover:bg-red-100 hover:text-red-500" title="删除">
            <PhX size="0.75rem" weight="fill" />
          </button>
        </div>
      </div>
    </div>

    <!-- 重命名弹窗 -->
    <Teleport to="body">
      <div v-if="editingTag" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="editingTag = ''" />
        <div class="relative bg-white rounded-xl shadow-xl p-6 w-80 space-y-4">
          <h3 class="text-sm font-medium text-gray-800">重命名标签</h3>
          <p class="text-xs text-gray-400">将 #{{ editingTag }} 重命名为：</p>
          <input v-model="newName" @keydown.enter="renameTag" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary" />
          <div class="flex gap-2 justify-end">
            <button @click="editingTag = ''" class="px-4 py-1.5 text-xs text-gray-500 rounded-lg border border-gray-200 hover:bg-gray-50">取消</button>
            <button @click="renameTag" class="px-4 py-1.5 text-white text-xs font-medium rounded-lg" style="background: rgb(var(--c-accent))">确定</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 删除确认弹窗 -->
    <Teleport to="body">
      <div v-if="confirmDeleteTag" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="confirmDeleteTag = ''" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-72 text-center">
          <p class="text-sm text-gray-700 mb-1">删除标签 #{{ confirmDeleteTag }}</p>
          <p class="text-xs text-gray-400 mb-4">将从所有笔记中移除此标签</p>
          <div class="flex gap-2 justify-center">
            <button @click="confirmDeleteTag = ''" class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
            <button @click="doDeleteTag" class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
