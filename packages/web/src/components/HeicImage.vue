<script setup lang="ts">
// HEIC 卡片渲染: 后端上传时已经生成了 <basename>.thumb.jpg, 前端直接 <img> 读它 (浏览器不能直接解 .heic).
// 失败 fallback (.thumb.jpg 不存在或损坏): 显示 "无法预览" 提示
import { ref } from 'vue';
import { resolveFileThumbUrl } from '@/utils/fileUrl';

const props = defineProps<{ url: string; alt?: string }>();

const failed = ref(false);
</script>

<template>
  <div class="w-full h-full flex items-center justify-center bg-gray-50">
    <img v-if="!failed" :src="resolveFileThumbUrl(props.url)" :alt="alt || ''"
      class="w-full h-full object-cover" @error="failed = true" />
    <div v-else class="text-xs text-gray-400">无法预览</div>
  </div>
</template>
