<script setup lang="ts">
// PDF 首页缩略图. 转码 + 缓存 + 持久化逻辑都在 utils/pdfCache.
// IntersectionObserver lazy: 卡片进入视口才开始 render, 避免一次性把屏幕外的 PDF 全部预渲染卡死
import { ref, onMounted, onUnmounted } from 'vue';
import { getOrRenderThumb } from '@/utils/pdfCache';

// fit: 'contain' 保留比例不裁(grid 默认), 'cover' 充满容器(list 36×36 缩略图)
const props = withDefaults(defineProps<{ src: string; fit?: 'contain' | 'cover' }>(), { fit: 'contain' });

const thumbUrl = ref<string | null>(null);
const loading = ref(false);
const failed = ref(false);
const container = ref<HTMLDivElement>();

let _observer: IntersectionObserver | null = null;
let _started = false;

async function start(): Promise<void> {
  if (_started) return;
  _started = true;
  loading.value = true;
  try {
    thumbUrl.value = await getOrRenderThumb(props.src);
  } catch (e: any) {
    console.warn('[PdfThumbnail]', props.src, e?.name, e?.message);
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (!container.value) return;
  _observer = new IntersectionObserver((entries) => {
    for (const ent of entries) {
      if (ent.isIntersecting) {
        start();
        _observer?.disconnect();
        _observer = null;
        break;
      }
    }
  }, { rootMargin: '200px' });
  _observer.observe(container.value);
});

onUnmounted(() => {
  _observer?.disconnect();
});
</script>

<template>
  <div ref="container" class="w-full h-full flex items-center justify-center bg-white">
    <img v-if="thumbUrl" :src="thumbUrl" class="w-full h-full" :class="fit === 'cover' ? 'object-cover' : 'object-contain'" alt="PDF preview" />
    <div v-else-if="loading" class="text-xs text-gray-400 animate-pulse">加载首页...</div>
    <div v-else-if="failed" class="text-xs text-gray-400">预览失败</div>
    <div v-else class="text-xs text-gray-300">PDF</div>
  </div>
</template>
