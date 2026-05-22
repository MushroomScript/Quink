<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { PhX, PhDownloadSimple, PhCaretLeft, PhCaretRight } from '@phosphor-icons/vue';
import { useImagePreview } from '@/composables/useImagePreview';

const { isOpen, currentImage, currentIndex, images, close, next, prev } = useImagePreview();

const zoom = ref(1);
const offset = ref({ x: 0, y: 0 });
const dragging = ref(false);

let dragStartX = 0;
let dragStartY = 0;
let dragMoved = false;

function resetView() { zoom.value = 1; offset.value = { x: 0, y: 0 }; }
// 切换图片时重置缩放/平移,否则放大状态切下一张会保留 zoom
watch(currentImage, resetView);

function handleWheel(e: WheelEvent) {
  if (!currentImage.value) return;
  e.preventDefault();
  const step = 0.2;
  const newZoom = Math.max(0.5, Math.min(4, zoom.value + (-Math.sign(e.deltaY) * step)));
  if (newZoom <= 1) offset.value = { x: 0, y: 0 };
  zoom.value = newZoom;
}

function handleImageMouseDown(e: MouseEvent) {
  if (zoom.value <= 1) return;
  e.preventDefault();
  dragging.value = true;
  dragMoved = false;
  dragStartX = e.clientX - offset.value.x;
  dragStartY = e.clientY - offset.value.y;
  window.addEventListener('mousemove', handleImageMouseMove);
  window.addEventListener('mouseup', handleImageMouseUp);
}

function handleImageMouseMove(e: MouseEvent) {
  if (!dragging.value) return;
  const nx = e.clientX - dragStartX;
  const ny = e.clientY - dragStartY;
  // 3px 阈值才算"拖动":避免抖动误判,刚拖完释放也触发 click → 区分关闭 vs 拖动
  if (Math.abs(nx - offset.value.x) > 3 || Math.abs(ny - offset.value.y) > 3) dragMoved = true;
  offset.value = { x: nx, y: ny };
}

function handleImageMouseUp() {
  dragging.value = false;
  window.removeEventListener('mousemove', handleImageMouseMove);
  window.removeEventListener('mouseup', handleImageMouseUp);
}

function handleImageClick() {
  if (dragMoved) { dragMoved = false; return; }
  close();
}

function handleKeydown(e: KeyboardEvent) {
  if (!isOpen.value) return;
  if (e.key === 'Escape') close();
  else if (e.key === 'ArrowLeft') prev();
  else if (e.key === 'ArrowRight') next();
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0"
      leave-active-class="transition duration-100 ease-in" leave-to-class="opacity-0">
      <div v-if="isOpen && currentImage"
        class="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 cursor-zoom-out"
        @click="close" @wheel="handleWheel">
        <img :src="currentImage.url" :alt="currentImage.filename" draggable="false"
          @mousedown="handleImageMouseDown" @click.stop="handleImageClick"
          :style="{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transition: dragging ? 'none' : 'transform 0.15s ease',
            cursor: dragging ? 'grabbing' : (zoom > 1 ? 'grab' : 'zoom-out'),
          }"
          class="max-w-[92vw] max-h-[88vh] object-contain rounded-md shadow-2xl select-none" />
        <button v-if="images.length > 1" @click.stop="prev"
          class="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="上一张 (←)">
          <PhCaretLeft size="1.25rem" weight="bold" />
        </button>
        <button v-if="images.length > 1" @click.stop="next"
          class="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="下一张 (→)">
          <PhCaretRight size="1.25rem" weight="bold" />
        </button>
        <button @click.stop="close"
          class="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="关闭 (Esc)">
          <PhX size="1.125rem" weight="bold" />
        </button>
        <a :href="currentImage.url" target="_blank" :download="currentImage.filename" @click.stop
          class="absolute top-4 right-16 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="下载">
          <PhDownloadSimple size="1.125rem" weight="fill" />
        </a>
        <div class="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-xs bg-black/40 px-3 py-1 rounded-full max-w-[80vw] truncate inline-flex items-center gap-2">
          <span class="truncate">{{ currentImage.filename }}</span>
          <span v-if="zoom !== 1" class="opacity-70 tabular-nums shrink-0">{{ Math.round(zoom * 100) }}%</span>
          <span v-if="images.length > 1" class="opacity-70 tabular-nums shrink-0">{{ currentIndex + 1 }}/{{ images.length }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
