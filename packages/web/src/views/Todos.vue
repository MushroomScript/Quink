<script setup lang="ts">
import { onActivated, computed, ref } from 'vue';
import { useNotesStore } from '@/stores/notes';
import NoteInput from '@/components/NoteInput.vue';
import MobileInput from '@/components/MobileInput.vue';
import NoteCard from '@/components/NoteCard.vue';
import { PhCheckSquare } from '@phosphor-icons/vue';

defineOptions({ name: 'todos' });

const store = useNotesStore();
const isMobile = ref(window.innerWidth < 768);

const pendingTodos = computed(() =>
  store.notes.filter((n) => n.type === 'todo' && n.todoStatus !== 'done')
);
const doneTodos = computed(() =>
  store.notes.filter((n) => n.type === 'todo' && n.todoStatus === 'done')
);

onActivated(() => {
  const needRefresh = store.filterType !== 'todo';
  store.filterType = 'todo';
  if (needRefresh) {
    store.searchQuery = '';
    store.fetchNotes();
  }
});
</script>

<template>
  <div class="px-4 md:px-8 py-4 md:py-6">
    <div class="mb-4 md:mb-6">
      <MobileInput v-if="isMobile" />
      <NoteInput v-else default-type="todo" />
    </div>

    <div v-if="pendingTodos.length > 0" class="mb-6 md:mb-8">
      <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">未完成 ({{ pendingTodos.length }})</h3>
      <div class="notes-masonry">
        <NoteCard v-for="note in pendingTodos" :key="note.id" :note="note" />
      </div>
    </div>

    <div v-if="doneTodos.length > 0">
      <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">已完成 ({{ doneTodos.length }})</h3>
      <div class="notes-masonry opacity-60">
        <NoteCard v-for="note in doneTodos" :key="note.id" :note="note" />
      </div>
    </div>

    <div v-if="store.notes.length === 0 && !store.loading" class="text-center py-16">
      <div class="mb-3 flex justify-center text-gray-300">
        <PhCheckSquare size="3rem" weight="fill" />
      </div>
      <p class="text-gray-500 text-sm">还没有待办事项</p>
      <p class="text-gray-400 text-xs mt-1">在上方输入框创建一个待办吧</p>
    </div>
  </div>
</template>
