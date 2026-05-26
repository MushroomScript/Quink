<script setup lang="ts">
// 卡片拖动期间的浮动 ghost (Teleport to body + fixed + pointer-events:none, 跟随鼠标).
// state 由 utils/cardDnd 提供, 这里只 reactive 渲染.
import { dragState } from '@/utils/cardDnd';
</script>

<template>
  <Teleport to="body">
    <div v-if="dragState.active"
      class="pointer-events-none fixed z-[9999]"
      :style="{ left: (dragState.ghostX + 12) + 'px', top: (dragState.ghostY + 12) + 'px' }">
      <div class="bg-white border border-gray-300 rounded-lg shadow-lg px-3 py-1.5 text-xs text-gray-700 max-w-[220px] truncate opacity-90">
        {{ dragState.ghostText }}
      </div>
    </div>
  </Teleport>
</template>
