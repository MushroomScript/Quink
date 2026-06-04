<script setup lang="ts">
import { ref, nextTick, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useGroupsStore } from '@/stores/groups';
import { useToast } from '@/composables/useToast';
import { useEscToClose } from '@/composables/useEscToClose';
import { PhUsersThree, PhCheck } from '@phosphor-icons/vue';

const emit = defineEmits<{ (e: 'close'): void }>();

const groups = useGroupsStore();
const toast = useToast();
const router = useRouter();

const name = ref('');
const autoJoin = ref(true);
const creating = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

// 弹出时聚焦输入框
onMounted(() => nextTick(() => inputEl.value?.focus()));

const opened = ref(true);
useEscToClose(opened);
// 转发 useEscToClose 状态到 emit (useEscToClose 写 false, 这里同步关弹窗)
watch(opened, (v) => { if (!v) emit('close'); });

async function submit() {
  const n = name.value.trim();
  if (!n) {
    toast.show('请输入群组名称', 'error');
    return;
  }
  if (creating.value) return;
  creating.value = true;
  try {
    const g = await groups.createGroup({ name: n, autoJoin: autoJoin.value });
    toast.show(`已创建群组「${g.name}」`, 'success');
    emit('close');
    router.push(`/groups/${g.id}`);
  } catch (e: any) {
    toast.show(e?.message || '创建失败', 'error');
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <Transition name="modal">
    <div class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" @click="emit('close')" />
      <div class="relative bg-white rounded-2xl shadow-xl p-6 w-80" style="border: 1px solid var(--sb-border)">
        <div class="flex items-center gap-2 mb-4">
          <div class="w-8 h-8 rounded-lg bg-primary/15 text-primary-dark flex items-center justify-center">
            <PhUsersThree size="1rem" weight="fill" />
          </div>
          <h3 class="text-sm font-medium">新建群组</h3>
        </div>

        <label class="block text-xs text-gray-500 mb-1">群组名</label>
        <input ref="inputEl" v-model="name" maxlength="50" @keydown.enter="submit"
          placeholder="我的群组"
          class="w-full px-3 py-2 mb-4 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary/20" />

        <label class="block text-xs text-gray-500 mb-2">加入方式</label>
        <div class="space-y-1 mb-5">
          <label class="flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors"
            :class="autoJoin ? 'bg-primary/5 ring-1 ring-primary/30' : ''">
            <input type="radio" :checked="autoJoin" @change="autoJoin = true" />
            <span class="text-xs text-gray-700">自动加入</span>
          </label>
          <label class="flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors"
            :class="!autoJoin ? 'bg-primary/5 ring-1 ring-primary/30' : ''">
            <input type="radio" :checked="!autoJoin" @change="autoJoin = false" />
            <span class="text-xs text-gray-700">管理员审核</span>
          </label>
        </div>

        <div class="flex gap-2 justify-end">
          <button @click="emit('close')" :disabled="creating"
            class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">取消</button>
          <button @click="submit" :disabled="creating || !name.trim()"
            class="px-4 py-1.5 text-xs rounded-lg font-medium bg-primary text-white hover:bg-primary-dark inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
            <PhCheck v-if="!creating" size="0.75rem" weight="bold" />
            {{ creating ? '创建中...' : '创建' }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
