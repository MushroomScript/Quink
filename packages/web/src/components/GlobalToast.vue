<script setup lang="ts">
import { useToast } from '@/composables/useToast';
const { state } = useToast();
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0 -translate-y-2"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition duration-150 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 -translate-y-2"
  >
    <div v-if="state.visible"
      class="fixed top-16 left-1/2 md:left-[calc(50%+7.5rem)] -translate-x-1/2 z-[9999] px-5 py-2.5 rounded-xl text-sm font-medium pointer-events-none select-none shadow-lg"
      :style="{
        background: state.kind === 'error'
          ? 'rgb(220 38 38 / 0.95)'
          : `rgb(var(--c-accent-dark))`,
        color: '#fff',
      }">
      {{ state.message }}
    </div>
  </Transition>
</template>
