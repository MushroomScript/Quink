<script setup lang="ts">
// 自定义 toggle 开关. Quink 无 UI 库依赖, 项目里 5 处开关共用本组件.
// size='md' (默认): 大号 h-6 w-11 配 text-sm 文字
// size='sm': 迷你 h-3 w-6 配 text-xs, 内嵌父级 button 时根元素用 span (不能 button 嵌 button)
// 圆球纯 flex items-center 几何居中. 显示比例切到 zoom 模式后所有元素 paint 层同比缩放, 无需 rem-based baseline 补偿.
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
    class="inline-flex h-3 w-6 items-center rounded-full transition-colors cursor-pointer align-middle shrink-0"
    :class="modelValue ? 'bg-primary' : 'bg-gray-300'">
    <span class="inline-block h-2 w-2 rounded-full bg-white shadow transition-transform"
      :class="modelValue ? 'translate-x-3.5' : 'translate-x-0.5'" />
  </span>
</template>
