<script setup lang="ts">
import { ref, nextTick, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useGroupsStore } from '@/stores/groups';
import { useToast } from '@/composables/useToast';
import { useEscToClose } from '@/composables/useEscToClose';
import { useInviteApply, parseInviteInput } from '@/composables/useInviteApply';
import { resolveFileUrl, resolveFileThumbUrl, thumbErrorFallback } from '@/utils/fileUrl';
import {
  PhUsersThree, PhCheck, PhSignIn, PhSpinner, PhPlus,
} from '@phosphor-icons/vue';

const emit = defineEmits<{ (e: 'close'): void }>();
const props = defineProps<{ initialTab?: 'join' | 'create' }>();

const groups = useGroupsStore();
const toast = useToast();
const router = useRouter();

const tab = ref<'join' | 'create'>(props.initialTab ?? 'join');

// === 加入 Tab ===
const inviteInput = ref('');
const inviteInputEl = ref<HTMLInputElement | null>(null);
const parseError = ref('');  // 格式错误 (跟 useInviteApply.errorMsg 区分: 后者是服务端校验失败)
let previewTimer: ReturnType<typeof setTimeout> | null = null;
const { preview, loading, errorMsg, applying, loadPreview, doApply, reset: resetInvite } = useInviteApply();

// 输入变化 → debounce 400ms → parse + loadPreview. 粘贴邀请链接立刻自动出预览, 不需要额外点查询
watch(inviteInput, (v) => {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  // 任何变更都清掉上次预览结果, 防"输错后旧预览还在"
  resetInvite();
  parseError.value = '';
  const s = v.trim();
  if (!s) return;
  previewTimer = setTimeout(() => {
    const token = parseInviteInput(s);
    if (!token) {
      parseError.value = '邀请码格式错误';
      return;
    }
    loadPreview(token);  // 错误只写到 errorMsg 不 throw, 模板显示
  }, 400);
});

async function doJoin() {
  const token = parseInviteInput(inviteInput.value);
  if (!token || !preview.value || applying.value) return;
  try {
    const r = await doApply(token);
    if (r.status === 'joined' || r.status === 'already_member') {
      toast.show(r.status === 'joined' ? '已加入群组' : '你已是该群成员', 'success');
      emit('close');
      router.push(`/groups/${r.groupId}`);
    } else {
      toast.show('已申请, 等待管理员审批', 'success');
      emit('close');
    }
  } catch (e: any) {
    toast.show(e?.message || '申请失败', 'error');
  }
}

// === 新建 Tab ===
const name = ref('');
const autoJoin = ref(true);
const creating = ref(false);
const nameInputEl = ref<HTMLInputElement | null>(null);

async function doCreate() {
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

// 切 tab 自动 focus 对应 input
watch(tab, async (t) => {
  await nextTick();
  if (t === 'join') inviteInputEl.value?.focus();
  else nameInputEl.value?.focus();
});

onMounted(() => nextTick(() => {
  if (tab.value === 'join') inviteInputEl.value?.focus();
  else nameInputEl.value?.focus();
}));

const opened = ref(true);
useEscToClose(opened);
watch(opened, (v) => { if (!v) emit('close'); });
</script>

<template>
  <Transition name="modal">
    <div class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" @click="emit('close')" />
      <!-- modal 外层 flex flex-col + min-h 保证 join/create 两 tab 视觉高度一致, 按钮 mt-auto 自动贴底 -->
      <div class="relative bg-white rounded-2xl shadow-xl p-6 w-[22rem] flex flex-col"
        style="border: 1px solid var(--sb-border); min-height: 21rem">
        <!-- Tab bar -->
        <div class="flex gap-1 mb-5 p-1 bg-gray-50 rounded-lg">
          <button @click="tab = 'join'"
            class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors inline-flex items-center justify-center gap-1"
            :class="tab === 'join' ? 'bg-primary/15 shadow-sm text-primary-dark' : 'text-gray-500 hover:text-gray-700'">
            <PhSignIn size="0.75rem" weight="fill" />
            加入群组
          </button>
          <button @click="tab = 'create'"
            class="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors inline-flex items-center justify-center gap-1"
            :class="tab === 'create' ? 'bg-primary/15 shadow-sm text-primary-dark' : 'text-gray-500 hover:text-gray-700'">
            <PhPlus size="0.75rem" weight="bold" />
            新建群组
          </button>
        </div>

        <!-- 加入 Tab -->
        <div v-if="tab === 'join'" class="flex-1 flex flex-col">
          <label class="block text-xs text-gray-500 mb-1">邀请码或邀请链接</label>
          <!-- 视觉微调: 内容向下 0.5px (padding 7/9 vs py-2 = 8/8) + caret 额外向下 1px (视觉 CSS px, zoom-invariant) -->
          <input ref="inviteInputEl" v-model="inviteInput" @keydown.enter="doJoin"
            placeholder="粘贴 16 位邀请码或完整邀请链接"
            data-caret-offset-y="1"
            style="padding-top: 7px; padding-bottom: 9px;"
            class="w-full px-3 mb-4 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary/20" />

          <!-- 状态区: 格式错 / loading / 服务端错 / preview, 互斥, 占位高度统一防抖. 默认空白不放提示文字 (蘑菇要求) -->
          <div class="min-h-[5.5rem]">
            <!-- 格式错 -->
            <p v-if="parseError" class="text-xs text-red-500 py-2">{{ parseError }}</p>

            <!-- loading 预览 -->
            <div v-else-if="loading" class="flex items-center gap-2 text-xs text-gray-400 py-2">
              <PhSpinner size="0.875rem" class="animate-spin" />
              加载邀请...
            </div>

            <!-- 服务端错 (token 无效/过期) -->
            <p v-else-if="errorMsg" class="text-xs text-red-500 py-2">{{ errorMsg }}</p>

            <!-- 预览卡: 头像 + 群名 + 成员数 + 加入方式. items-center 让文字垂直居中, 上下 padding 等距 (蘑菇要求) -->
            <div v-else-if="preview" class="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
              <img v-if="preview.avatar" :src="resolveFileThumbUrl(preview.avatar)"
                @error="thumbErrorFallback($event, resolveFileUrl(preview.avatar))"
                alt="头像" class="w-12 h-12 rounded-lg object-cover shrink-0" />
              <div v-else class="w-12 h-12 rounded-lg bg-primary/15 text-primary-dark flex items-center justify-center shrink-0">
                <PhUsersThree size="1.5rem" weight="fill" />
              </div>
              <!-- 文字整块上移 2px (蘑菇微调), 保持中间字间距不变 -->
              <div class="flex-1 min-w-0 -translate-y-0.5">
                <p class="text-sm font-medium text-gray-800 truncate">{{ preview.name }}</p>
                <p class="text-xs text-gray-400 mt-0.5">
                  {{ preview.memberCount }} 位成员 · {{ preview.autoJoin ? '自动加入' : '需审批' }}
                </p>
              </div>
            </div>
          </div>

          <div class="flex gap-2 justify-end mt-auto">
            <button @click="emit('close')" :disabled="applying"
              class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">取消</button>
            <button @click="doJoin" :disabled="!preview || applying"
              class="px-4 py-1.5 text-xs rounded-lg font-medium bg-primary text-white hover:bg-primary-dark inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
              <PhSpinner v-if="applying" size="0.75rem" class="animate-spin" />
              <PhSignIn v-else size="0.75rem" weight="fill" />
              {{ applying ? '申请中...' : (preview?.autoJoin === false ? '申请加入' : '加入') }}
            </button>
          </div>
        </div>

        <!-- 新建 Tab -->
        <div v-else class="flex-1 flex flex-col">
          <label class="block text-xs text-gray-500 mb-1">群组名</label>
          <!-- 视觉微调 (跟加入 Tab 同步): 内容向下 0.5px + caret 额外向下 1px (视觉 CSS px, zoom-invariant) -->
          <input ref="nameInputEl" v-model="name" maxlength="50" @keydown.enter="doCreate"
            placeholder="我的群组"
            data-caret-offset-y="1"
            style="padding-top: 7px; padding-bottom: 9px;"
            class="w-full px-3 mb-4 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary/20" />

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

          <div class="flex gap-2 justify-end mt-auto">
            <button @click="emit('close')" :disabled="creating"
              class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">取消</button>
            <button @click="doCreate" :disabled="creating || !name.trim()"
              class="px-4 py-1.5 text-xs rounded-lg font-medium bg-primary text-white hover:bg-primary-dark inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
              <PhCheck v-if="!creating" size="0.75rem" weight="bold" />
              {{ creating ? '创建中...' : '创建' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
