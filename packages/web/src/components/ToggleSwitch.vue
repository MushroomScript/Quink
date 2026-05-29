<script setup lang="ts">
// 自定义 toggle 开关. Quink 无 UI 库依赖, 项目里 5 处开关共用本组件.
// size='md' (默认): 大号 h-6 w-11 配 text-sm 文字, 视觉对齐 OK 无需 baseline 补偿
// size='sm': 迷你 h-3 w-6, 内嵌父级 button 时根元素用 span (不能 button 嵌 button);
//   胶囊整体 translate-y-px + 圆点 translate-y-[0.5px] 补 text-xs 中文 baseline 偏下视觉差
//   (跟 commit 47bb87d 修按钮 padding 同根因). 跨字号亚像素 round 限制: 18 完美对齐, 14/22 微偏 < 1px
const props = withDefaults(defineProps<{
  modelValue: boolean;
  size?: 'sm' | 'md';
}>(), { size: 'md' });

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

function toggle() { emit('update:modelValue', !props.modelValue); }
</script>

<template>
  <button v-if="size === 'md'" @click="toggle" type="button"
    class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0"
    :class="modelValue ? 'bg-primary' : 'bg-gray-300'">
    <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
      :class="modelValue ? 'translate-x-6' : 'translate-x-1'" />
  </button>
  <span v-else @click="toggle" role="switch"
    class="inline-flex h-3 w-6 items-center rounded-full transition-colors cursor-pointer align-middle shrink-0 translate-y-px"
    :class="modelValue ? 'bg-primary' : 'bg-gray-300'">
    <span class="inline-block h-2 w-2 rounded-full bg-white shadow transition-transform translate-y-[0.5px]"
      :class="modelValue ? 'translate-x-3.5' : 'translate-x-0.5'" />
  </span>
</template>
