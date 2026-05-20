<script setup lang="ts">
import { onActivated, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useNotesStore } from '@/stores/notes';
import NoteInput from '@/components/NoteInput.vue';
import MobileInput from '@/components/MobileInput.vue';
import NoteCard from '@/components/NoteCard.vue';
import { PhLightbulb } from '@phosphor-icons/vue';
import { fadeOutLeave, snapshotCards } from '@/utils/cardLeave';

defineOptions({ name: 'inspiration' });

const store = useNotesStore();
const route = useRoute();
const isMobile = ref(window.innerWidth < 768);

// 数据变更前主动 snapshot 所有卡片位置，避免 onLeave 钩子里拿到的是 v-if 切换后的错位坐标
watch(() => store.notes.length, () => snapshotCards(), { flush: 'sync' });

onActivated(() => {
  const tagQuery = route.query.tag as string;
  if (tagQuery) {
    store.filterType = '';
    store.searchQuery = '';
    store.fetchNotes({ tags: tagQuery });
    window.dispatchEvent(new CustomEvent('quink-filter-tag', { detail: tagQuery }));
    return;
  }
  const needRefresh = store.filterType !== 'note';
  store.filterType = 'note';
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
      <NoteInput v-else default-type="note" />
    </div>

    <div v-if="store.loading" class="text-center py-12 text-gray-400 text-sm">加载中...</div>

    <template v-else>
      <div v-if="store.notes.length === 0" class="text-center py-16">
        <div class="mb-3 flex justify-center text-gray-300">
          <PhLightbulb size="3rem" weight="fill" />
        </div>
        <p class="text-gray-500 text-sm">还没有记录任何灵感</p>
        <p class="text-gray-400 text-xs mt-1">在上方输入框写下你的第一个闪念吧</p>
      </div>

      <TransitionGroup tag="div" class="notes-masonry" :css="false" @leave="fadeOutLeave">
        <NoteCard v-for="note in store.notes" :key="note.id" :note="note" />
      </TransitionGroup>
    </template>

    <div v-if="store.total > store.notes.length" class="text-center py-6">
      <p class="text-xs text-gray-400">显示 {{ store.notes.length }} / {{ store.total }} 条</p>
    </div>
  </div>
</template>
