<script setup lang="ts">
// 自定义 toggle 开关. Quink 无 UI 库依赖, 项目里 5 处开关共用本组件.
// size='md' (默认): 大号 h-6 w-11 配 text-sm 文字, 圆球 flex items-center 几何居中
// size='sm': 迷你 h-3 w-6, 内嵌父级 button 时根元素用 span (不能 button 嵌 button);
//   胶囊整体 translate-y-px 补"开关 vs 中文文字"对齐 (中文 baseline 偏下);
//   圆球本身不加 translate-y, 跟 md 一样靠 flex items-center 几何居中, 跨字号一致 (rem-based 字号下 round 奇偶不可控,
//   加固定 px 偏移只在特定字号下完美, 其他字号反而偏). 详见 commit 47bb87d 同根因.
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
    <span class="inline-block h-2 w-2 rounded-full bg-white shadow transition-transform"
      :class="modelValue ? 'translate-x-3.5' : 'translate-x-0.5'" />
  </span>
</template>
