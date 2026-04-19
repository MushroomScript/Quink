<script setup lang="ts">
import { onActivated, ref } from 'vue';
import { useNotesStore } from '@/stores/notes';
import NoteInput from '@/components/NoteInput.vue';
import MobileInput from '@/components/MobileInput.vue';
import NoteCard from '@/components/NoteCard.vue';

defineOptions({ name: 'inspiration' });

const store = useNotesStore();
const isMobile = ref(window.innerWidth < 768);

onActivated(() => {
  store.filterType = 'note';
  store.searchQuery = '';
  store.fetchNotes();
});
</script>

<template>
  <div class="px-4 md:px-8 py-4 md:py-6">
    <div class="mb-4 md:mb-6">
      <MobileInput v-if="isMobile" />
      <NoteInput v-else default-type="note" />
    </div>

    <div v-if="store.loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="store.notes.length === 0" class="text-center py-16">
      <div class="text-4xl mb-3">💡</div>
      <p class="text-gray-500 text-sm">还没有记录任何灵感</p>
      <p class="text-gray-400 text-xs mt-1">在上方输入框写下你的第一个闪念吧</p>
    </div>

    <div v-else class="notes-masonry">
      <NoteCard v-for="note in store.notes" :key="note.id" :note="note" />
    </div>

    <div v-if="store.total > store.notes.length" class="text-center py-6">
      <p class="text-xs text-gray-400">显示 {{ store.notes.length }} / {{ store.total }} 条</p>
    </div>
  </div>
</template>
