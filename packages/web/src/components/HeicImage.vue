<script setup lang="ts">
// HEIC 卡片渲染: 后端上传时已经生成了 <basename>.thumb.jpg, 前端直接 <img> 读它.
// 失败 fallback (.thumb.jpg 不存在或损坏): 显示 "无法预览" 提示
import { ref } from 'vue';
import { heicThumbUrl } from '@/utils/heicCache';

const props = defineProps<{ src: string; alt?: string }>();

const failed = ref(false);
</script>

<template>
  <div class="w-full h-full flex items-center justify-center bg-gray-50">
    <img v-if="!failed" :src="heicThumbUrl(src)" :alt="alt || ''"
      class="w-full h-full object-cover" @error="failed = true" />
    <div v-else class="text-xs text-gray-400">无法预览</div>
  </div>
</template>
