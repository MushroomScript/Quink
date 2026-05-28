<script setup lang="ts">
// 视频首帧缩略图组件. 跟 PdfThumbnail 同 pattern: IntersectionObserver lazy + 内存/磁盘双缓存.
// 缓存命中后用 <img> 显示, 不再挂 <video> 元素 → 0 个媒体 pipeline 占用, list view 滚动流畅
import { ref, onMounted, onUnmounted } from 'vue';
import { PhPlayCircle } from '@phosphor-icons/vue';
import { getOrCaptureVideoThumb } from '@/utils/videoThumbCache';

const props = withDefaults(defineProps<{ src: string; fit?: 'contain' | 'cover' }>(), { fit: 'cover' });

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
    thumbUrl.value = await getOrCaptureVideoThumb(props.src);
  } catch (e: any) {
    console.warn('[VideoThumbnail]', props.src, e?.message);
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

onUnmounted(() => { _observer?.disconnect(); });
</script>

<template>
  <div ref="container" class="relative w-full h-full bg-black">
    <img v-if="thumbUrl" :src="thumbUrl"
      class="w-full h-full"
      :class="fit === 'cover' ? 'object-cover' : 'object-contain'"
      alt="video preview" />
    <div v-else-if="loading" class="absolute inset-0 flex items-center justify-center text-[10px] text-white/60 animate-pulse">
      加载...
    </div>
    <div v-else-if="failed" class="absolute inset-0 flex items-center justify-center text-[10px] text-white/60">
      无法预览
    </div>
    <!-- play icon overlay: cover 时(list view 36px 小图)用小图标贴右下, contain 时(grid view 大图)居中大图标 -->
    <PhPlayCircle v-if="thumbUrl"
      :size="fit === 'cover' ? '0.875rem' : '2.5rem'"
      weight="fill"
      class="absolute drop-shadow pointer-events-none opacity-90 text-white"
      :class="fit === 'cover' ? 'right-0.5 bottom-0.5' : 'inset-0 m-auto'" />
  </div>
</template>
