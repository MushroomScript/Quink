<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useNotesStore } from '@/stores/notes';
import NoteInput from '@/components/NoteInput.vue';
import MobileInput from '@/components/MobileInput.vue';
import NoteCard from '@/components/NoteCard.vue';

const store = useNotesStore();
const isMobile = ref(window.innerWidth < 768);
const filterType = ref('');

const typeFilters = [
  { value: '', label: '全部' },
  { value: 'note', label: '笔记' },
  { value: 'snippet', label: '代码片段' },
  { value: 'link', label: '链接' },
];

function setFilter(type: string) {
  filterType.value = type;
  store.filterType = type;
  store.fetchNotes();
}

onMounted(() => {
  store.filterType = '';
  store.filterCategory = '';
  store.searchQuery = '';
  store.fetchNotes();
});
</script>

<template>
  <div class="px-4 md:px-8 py-6">
    <div class="mb-4 md:mb-6">
      <MobileInput v-if="isMobile" />
      <NoteInput v-else default-type="snippet" />
    </div>

    <div class="flex gap-1 mb-6">
      <button
        v-for="f in typeFilters"
        :key="f.value"
        @click="setFilter(f.value)"
        class="px-3 py-1.5 rounded-lg text-xs transition-colors"
        :class="filterType === f.value
          ? 'bg-primary-light text-primary-dark font-medium'
          : 'text-gray-500 hover:bg-gray-100'"
      >
        {{ f.label }}
      </button>
    </div>

    <div v-if="store.loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="store.notes.length === 0" class="text-center py-16">
      <div class="text-4xl mb-3">📝</div>
      <p class="text-gray-500 text-sm">暂无笔记</p>
    </div>

    <div v-else class="space-y-3">
      <NoteCard v-for="note in store.notes" :key="note.id" :note="note" />
    </div>
  </div>
</template>
