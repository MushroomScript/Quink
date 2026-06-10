<script setup lang="ts">
import { onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { isLoggedIn } from '@/api';
import { useToast } from '@/composables/useToast';
import { useInviteApply } from '@/composables/useInviteApply';
import { resolveFileUrl, resolveFileThumbUrl, thumbErrorFallback } from '@/utils/fileUrl';
import { PhUsersThree, PhSignIn, PhSpinner } from '@phosphor-icons/vue';

const route = useRoute();
const router = useRouter();
const toast = useToast();

const token = computed(() => String(route.params.token));
// 共享 useInviteApply (跟 GroupActionModal 同一套预览+申请逻辑)
// preview/loading/errorMsg/applying/result 跟原本 ref 同名同语义
const { preview, loading, errorMsg, applying, result, loadPreview, doApply } = useInviteApply();

async function tryApply() {
  if (!preview.value || applying.value) return;
  // 未登录: 跳登录页, 登录回跳回本页 (用 redirect query)
  if (!isLoggedIn()) {
    router.push({ path: '/login', query: { redirect: route.fullPath } });
    return;
  }
  try {
    const r = await doApply(token.value);
    if (r.status === 'joined' || r.status === 'already_member') {
      toast.show(r.status === 'joined' ? '已加入群组' : '你已是该群成员', 'success');
      router.replace(`/groups/${r.groupId}`);
    } else {
      // pending: 等审批, 留在本页显示 status
      toast.show('已申请, 等待管理员审批', 'success');
    }
  } catch (e: any) {
    toast.show(e?.message || '申请失败', 'error');
  }
}

onMounted(() => {
  // loadPreview 失败只写 errorMsg 不 throw, 模板用 errorMsg 显示
  loadPreview(token.value);
});
</script>

<template>
  <!-- 跟登录页 layout 完全一致: min-h-full (= #app height = var(--app-height) 在 CSS zoom 下正确)
       + pb-[12vh] 让卡片居中后整体上移 6vh 视觉略偏上. 不用 min-h-screen 因为 CSS zoom 下 100vh 行为不靠谱
       (跟当初 setAppHeight 双倍计算同根因). 也不加 py-8, 跟 pb-[12vh] 的 padding-bottom 不对称会破坏居中 -->
  <div class="min-h-full flex items-center justify-center px-4 pb-[12vh]" style="background: var(--c-body)">
    <div class="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6" style="border: 1px solid var(--sb-border)">
      <!-- 加载中 -->
      <div v-if="loading" class="text-center py-8">
        <PhSpinner size="2rem" class="animate-spin text-gray-300 mx-auto mb-2" />
        <p class="text-xs text-gray-400">加载邀请...</p>
      </div>

      <!-- 错误: token 无效/过期 -->
      <div v-else-if="errorMsg" class="text-center py-8">
        <div class="w-12 h-12 mx-auto mb-3 rounded-full bg-red-50 text-red-400 flex items-center justify-center">
          <PhUsersThree size="1.5rem" weight="fill" />
        </div>
        <p class="text-sm text-gray-700 mb-1">无法加入</p>
        <p class="text-xs text-gray-400 mb-4">{{ errorMsg }}</p>
        <button @click="router.push('/quink')" class="px-4 py-1.5 text-xs rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200">
          返回首页
        </button>
      </div>

      <!-- 申请成功 (pending): 等审批状态 -->
      <div v-else-if="result?.status === 'pending'" class="text-center py-4">
        <div class="w-14 h-14 mx-auto mb-3 rounded-2xl bg-primary/15 text-primary-dark flex items-center justify-center">
          <PhUsersThree size="2rem" weight="fill" />
        </div>
        <h2 class="text-base font-medium mb-1">已申请加入</h2>
        <p class="text-sm text-gray-500 mb-1">{{ preview?.name }}</p>
        <p class="text-xs text-gray-400 mb-5">等待管理员审批, 通过后会自动加入</p>
        <button @click="router.push('/quink')" class="px-4 py-1.5 text-xs rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200">
          返回首页
        </button>
      </div>

      <!-- 邀请预览 + 申请按钮 -->
      <div v-else-if="preview" class="text-center">
        <img v-if="preview.avatar" :src="resolveFileThumbUrl(preview.avatar)"
          @error="thumbErrorFallback($event, resolveFileUrl(preview.avatar))"
          alt="头像" class="w-16 h-16 rounded-2xl object-cover mx-auto mb-3" />
        <div v-else class="w-16 h-16 mx-auto mb-3 rounded-2xl bg-primary/15 text-primary-dark flex items-center justify-center">
          <PhUsersThree size="2rem" weight="fill" />
        </div>
        <p class="text-xs text-gray-400 mb-1">邀请你加入群组</p>
        <h2 class="text-lg font-medium mb-1">{{ preview.name }}</h2>
        <p class="text-xs text-gray-400 mb-5">{{ preview.memberCount }} 位成员 · {{ preview.autoJoin ? '自动加入' : '需管理员审批' }}</p>
        <button @click="tryApply" :disabled="applying"
          class="w-full px-4 py-2.5 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-dark inline-flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed">
          <PhSpinner v-if="applying" size="1rem" class="animate-spin" />
          <PhSignIn v-else size="1rem" weight="fill" />
          {{ applying ? '申请中...' : (preview.autoJoin ? '加入群组' : '申请加入') }}
        </button>
      </div>
    </div>
  </div>
</template>
