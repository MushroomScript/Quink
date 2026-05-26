<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue';
import dayjs from 'dayjs';

const props = defineProps<{
  open: boolean;
  defaultName: string;
  ext: string;
  title?: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm', name: string): void;
  (e: 'cancel'): void;
}>();

const name = ref(props.defaultName);
const inputEl = ref<HTMLInputElement | null>(null);
const datePrefix = ref('');

// 与后端 sanitizeName 保持一致，纯用于预览
function sanitize(s: string): string {
  let r = s.trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!r) r = '未命名';
  if (r.length > 100) r = r.slice(0, 100);
  return r;
}

const previewName = computed(() => {
  const safe = sanitize(name.value || props.defaultName);
  return `${datePrefix.value}_${safe}.${props.ext}`;
});

// 弹窗打开时重置 name + 当前时间 + autofocus/select + 挂 ESC 关闭 (cleanup 在关闭/卸载时移除)
watch(() => props.open, (v, _old, onCleanup) => {
  if (!v) return;
  name.value = props.defaultName;
  datePrefix.value = dayjs().format('YYYY-MM-DD_HHmmss');
  nextTick(() => {
    inputEl.value?.focus();
    inputEl.value?.select();
  });
  const handler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };
  document.addEventListener('keydown', handler);
  onCleanup(() => document.removeEventListener('keydown', handler));
});

function onConfirm() {
  const finalName = name.value.trim() || props.defaultName;
  emit('confirm', finalName);
  emit('update:open', false);
}

function onCancel() {
  emit('cancel');
  emit('update:open', false);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="fixed inset-0 z-[200] flex items-center justify-center">
        <div class="absolute inset-0 bg-black/30" @click="onCancel" />
        <div class="relative bg-white rounded-xl shadow-xl p-5 w-80">
          <p class="text-sm text-gray-700 mb-3">{{ title || '重命名' }}</p>
          <input
            ref="inputEl"
            v-model="name"
            type="text"
            spellcheck="false"
            class="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 focus:outline-none focus:border-primary"
            @keydown.enter.prevent="onConfirm"
            @keydown.esc.prevent="onCancel"
          />
          <p class="text-xs text-gray-400 mt-2 break-all">将保存为：{{ previewName }}</p>
          <div class="flex gap-2 justify-end mt-4">
            <button
              type="button"
              class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
              @click="onCancel"
            >
              取消
            </button>
            <button
              type="button"
              class="px-4 py-1.5 text-xs rounded-lg font-medium text-white bg-primary hover:bg-primary-dark"
              @click="onConfirm"
            >
              确认
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
