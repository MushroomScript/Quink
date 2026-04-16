<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useNotesStore } from '@/stores/notes';
import NoteInput from '@/components/NoteInput.vue';
import MobileInput from '@/components/MobileInput.vue';
import NoteCard from '@/components/NoteCard.vue';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';

dayjs.locale('zh-cn');

const store = useNotesStore();
const isMobile = ref(window.innerWidth < 768);

function formatDateHeader(dateStr: string) {
  const d = dayjs(dateStr);
  const today = dayjs().format('YYYY-MM-DD');
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  if (dateStr === today) return '今天';
  if (dateStr === yesterday) return '昨天';
  return d.format('YYYY年M月D日');
}

onMounted(() => {
  store.filterType = '';
  store.searchQuery = '';
  store.fetchNotes();
});
</script>

<template>
  <div class="px-4 md:px-8 py-4 md:py-8">
    <div class="mb-4 md:mb-6">
      <MobileInput v-if="isMobile" />
      <NoteInput v-else />
    </div>

    <div v-if="store.loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <div v-else-if="store.notes.length === 0" class="text-center py-16">
      <div class="text-4xl mb-3">💡</div>
      <p class="text-gray-500 text-sm">还没有记录任何灵感</p>
      <p class="text-gray-400 text-xs mt-1">在上方输入框写下你的第一个闪念吧</p>
    </div>

    <div v-else class="space-y-6 md:space-y-8">
      <div v-for="(notes, date) in store.groupedByDate" :key="date">
        <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          {{ formatDateHeader(date) }}
        </h3>
        <div class="space-y-3">
          <NoteCard v-for="note in notes" :key="note.id" :note="note" />
        </div>
      </div>
    </div>

    <div v-if="store.total > store.notes.length" class="text-center py-6">
      <p class="text-xs text-gray-400">显示 {{ store.notes.length }} / {{ store.total }} 条</p>
    </div>
  </div>
</template>
