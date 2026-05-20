<script setup lang="ts">
import { onActivated, ref, watch } from 'vue';
import { useNotesStore } from '@/stores/notes';
import NoteInput from '@/components/NoteInput.vue';
import MobileInput from '@/components/MobileInput.vue';
import NoteCard from '@/components/NoteCard.vue';
import { PhNotePencil } from '@phosphor-icons/vue';
import { fadeOutLeave, snapshotCards } from '@/utils/cardLeave';

defineOptions({ name: 'notes' });

const store = useNotesStore();
const isMobile = ref(window.innerWidth < 768);

onActivated(() => {
  const needRefresh = store.filterType !== 'snippet';
  store.filterType = 'snippet';
  if (needRefresh) {
    store.filterCategory = '';
    store.searchQuery = '';
    store.fetchNotes();
  }
});

// 数据变更前主动 snapshot 所有卡片位置，避免 onLeave 钩子里拿到的是 v-if 切换后的错位坐标
watch(() => store.notes.length, () => snapshotCards(), { flush: 'sync' });
</script>

<template>
  <div class="px-4 md:px-8 py-4 md:py-6">
    <div class="mb-4 md:mb-6">
      <MobileInput v-if="isMobile" />
      <NoteInput v-else default-type="snippet" />
    </div>

    <div v-if="store.loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <div v-if="store.notes.length === 0" class="text-center py-16">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhNotePencil size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">暂无笔记</p>
      </div>

      <TransitionGroup tag="div" class="notes-masonry" :css="false" @leave="fadeOutLeave">
        <NoteCard v-for="note in store.notes" :key="note.id" :note="note" />
      </TransitionGroup>
    </template>
  </div>
</template>
