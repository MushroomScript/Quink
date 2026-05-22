import { ref, computed } from 'vue';

export interface PreviewImage {
  url: string;
  filename: string;
}

// 全局单例 state:同一时刻只能有一个图片预览,所有 view 共享 modal
const images = ref<PreviewImage[]>([]);
const currentIndex = ref(0);
const isOpen = ref(false);

const currentImage = computed<PreviewImage | null>(() =>
  isOpen.value && images.value.length > 0 ? images.value[currentIndex.value] : null
);

function open(imgs: PreviewImage[], index = 0) {
  if (imgs.length === 0) return;
  images.value = imgs;
  currentIndex.value = Math.max(0, Math.min(index, imgs.length - 1));
  isOpen.value = true;
}

function close() {
  isOpen.value = false;
}

function next() {
  if (images.value.length <= 1) return;
  currentIndex.value = (currentIndex.value + 1) % images.value.length;
}

function prev() {
  if (images.value.length <= 1) return;
  currentIndex.value = (currentIndex.value - 1 + images.value.length) % images.value.length;
}

export function useImagePreview() {
  return { images, currentIndex, isOpen, currentImage, open, close, next, prev };
}
