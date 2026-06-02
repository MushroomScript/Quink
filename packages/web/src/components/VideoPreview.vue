<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { PhX, PhDownloadSimple } from '@phosphor-icons/vue';
import { useVideoPreview } from '@/composables/useVideoPreview';

const { current, close } = useVideoPreview();

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && current.value) close();
}
onMounted(() => document.addEventListener('keydown', onKey));
onUnmounted(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="current"
        class="fixed inset-0 z-[300] flex items-center justify-center bg-black/85 cursor-pointer"
        @click="close">
        <!-- 视频本身不响应外层点击关闭, @click.stop 防止点 video controls 时穿透关 modal.
             禁 controlslist 全部三点菜单内项 + disablepictureinpicture, 让 Chromium overflow menu 无内容自动隐藏
             (蘑菇说菜单展开后被三点按钮遮住关不掉 — Chromium 已知行为, 禁项让菜单消失绕开) -->
        <video :src="current.url" controls autoplay
          controlslist="nodownload noremoteplayback noplaybackrate"
          disablepictureinpicture
          class="max-w-[92vw] max-h-[88vh] rounded-md shadow-2xl bg-black"
          @click.stop />
        <button @click.stop="close"
          class="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="关闭 (Esc)">
          <PhX size="1.125rem" weight="bold" />
        </button>
        <a :href="current.url" :download="current.filename" @click.stop
          class="absolute top-4 right-16 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="下载">
          <PhDownloadSimple size="1.125rem" weight="fill" />
        </a>
        <div class="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-xs bg-black/40 px-3 py-1 rounded-full max-w-[80vw] truncate">
          {{ current.filename }}
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 150ms ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
