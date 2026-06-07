<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useNotesStore } from '@/stores/notes';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import RichEditor from './RichEditor.vue';
import { api, type Note } from '@/api';
import { PhXCircle } from '@phosphor-icons/vue';

const props = defineProps<{ note: Note; initialFullscreen?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const route = useRoute();
const store = useNotesStore();
const auth = useAuthStore();
const toast = useToast();
// 是否是我自己写的笔记. RichEditor.submit 永远回传 visibility/sharedGroupIds (form data 总带),
// 但非作者改共享笔记时不能把这俩字段透传给 PATCH, 否则后端撞"只有作者可以修改共享设置" 403.
const isMyNote = computed(() => !props.note.userId || props.note.userId === auth.user?.id);
const saving = ref(false);
const editorRef = ref<InstanceType<typeof RichEditor>>();
const modalCardRef = ref<HTMLElement>();
const showConfirm = ref(false);

// PR #7b: 从 router path 自动识别群上下文. /groups/:gid 形式 → editContext.groupId, 否则 undefined (主视图改).
// 后端用这字段决定是否 fork: 非作者必 fork; 作者改 root 多群也 fork (避免误改影响多群).
const editGroupId = computed<string | undefined>(() => {
  const m = route.path.match(/^\/groups\/([^/]+)/);
  return m ? m[1] : undefined;
});

// PR #5 编辑锁: 仅 shared 笔记走 (private 不需要协作锁, 直接编辑).
// onMounted 先 try acquire, 失败 → 不打开 modal 直接 emit close;
// 成功 → showInner = true 启动 enter 动画 + 30s 心跳续约.
// onBeforeUnmount → fetch keepalive DELETE 释放锁 (兼容页面 unload + Vue unmount 两种 case).
const isSharedNote = computed(() => props.note.visibility === 'shared');
const lockToken = ref<string | null>(null);
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const showInner = ref(false);

// PR #9: 申请编辑权弹窗 (无 write 权限的人点编辑 → 不进编辑器, 弹申请理由对话框)
const showRequestPerm = ref(false);
const requestPermLabel = ref<'admin' | 'all'>('admin');
const requestPermMessage = ref('');
const submittingRequest = ref(false);
async function submitEditRequest() {
  if (submittingRequest.value) return;
  submittingRequest.value = true;
  try {
    await api.requestNoteEditPermission(props.note.id, requestPermMessage.value.trim() || undefined);
    toast.show('已提交申请, 等待作者或管理员审批', 'success', 3000);
    showRequestPerm.value = false;
    emit('close');
  } catch (e: any) {
    toast.show('申请失败: ' + (e.message || '未知错误'), 'error', 3000);
  } finally { submittingRequest.value = false; }
}
function cancelEditRequest() {
  showRequestPerm.value = false;
  emit('close');
}

async function acquireLock(): Promise<boolean> {
  if (!isSharedNote.value) return true;
  // PR #5b (蘑菇 2026-06-07 修订): 唯一免锁场景 = 作者主视图改 root 多群. 其它都申锁:
  //   - 非作者: 协作场景必锁
  //   - 作者改 fork: fork 是群协作版本
  //   - 作者改 root 单群: 单群 root 等价 fork
  //   - 作者改 root 多群 + 群组页: 后端会 fork, 跟非作者改 root 同款流程
  if (isMyNote.value) {
    const isFork = !!props.note.parentNoteId;
    const shareCount = props.note.sharedGroupIds?.length ?? 0;
    const isMainView = !editGroupId.value;
    if (!isFork && shareCount > 1 && isMainView) return true;
  }
  const tok = localStorage.getItem('quink_token');
  try {
    const res = await fetch(`/api/notes/${props.note.id}/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as any));
      if (res.status === 409 && body.error === 'locked') {
        toast.show(`「${body.lockByNickname}」正在编辑此笔记，稍后再试`, 'error', 3500);
      } else if (res.status === 403 && body.error === 'no_write_permission') {
        // PR #9: 没编辑权 → 弹申请编辑权对话框 (输入理由 + 提交申请/取消). 不进编辑器
        requestPermLabel.value = body.editPermission === 'admin' ? 'admin' : 'all';
        requestPermMessage.value = '';
        showRequestPerm.value = true;
        return false;
      } else {
        toast.show('无法获取编辑锁：' + (body.error || res.statusText), 'error', 3000);
      }
      return false;
    }
    const data = await res.json();
    lockToken.value = data.data.lockToken;
    startHeartbeat();
    return true;
  } catch (e: any) {
    toast.show('编辑锁请求失败：' + (e.message || '未知错误'), 'error', 3000);
    return false;
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  // 30s 一次, server TTL 5min, 4-5 次心跳过期; 心跳失败 = 锁丢, 提示用户重新打开
  heartbeatTimer = setInterval(async () => {
    if (!lockToken.value) return;
    const tok = localStorage.getItem('quink_token');
    try {
      const res = await fetch(`/api/notes/${props.note.id}/lock/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ lockToken: lockToken.value }),
      });
      if (!res.ok) {
        toast.show('编辑锁已失效，请关闭后重新打开笔记', 'error', 3000);
        stopHeartbeat();
        lockToken.value = null;
      }
    } catch (e) { /* 网络抖动忽略, 下次心跳重试 */ }
  }, 30 * 1000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// fetch keepalive: 页面 unload 时也能完成发送 (跟 sendBeacon 同语义但支持 DELETE method).
// 兼容 Vue component unmount + 浏览器关 tab 两种场景, 不用区分.
function releaseLockOnUnmount() {
  if (!lockToken.value) return;
  const tok = localStorage.getItem('quink_token');
  fetch(`/api/notes/${props.note.id}/lock`, {
    method: 'DELETE',
    keepalive: true,
    headers: { Authorization: `Bearer ${tok}` },
  }).catch(() => {});
  lockToken.value = null;
  stopHeartbeat();
}

onMounted(async () => {
  const ok = await acquireLock();
  if (!ok) {
    // 拿不到锁: 申请编辑权弹窗已弹时不关, 用户点取消/提交后才关; 其他失败 (lock 409 / 网络错) 直接 close
    if (!showRequestPerm.value) emit('close');
    return;
  }
  nextTick(() => { showInner.value = true; });
});

async function onSubmit(data: { html: string; type: string; tags: string[]; visibility: 'private' | 'shared'; sharedGroupIds: string[] }) {
  if (saving.value) return;
  saving.value = true;
  try {
    const patchData: any = {
      content: data.html,
      type: data.type as any,
      tags: data.tags,
    };
    // 分享设置 (visibility / sharedGroupIds) 仅"主视图 + 作者本人"才传:
    //   非作者传 → 后端 403 "只有作者可以修改共享设置"
    //   作者从群组页改 root 多群 → 后端进入 fork 路径, 此时传分享设置撞 400 "fork 不允许改 visibility/sharedGroupIds"
    // 群组页改语义是"改本群版本", 分享设置改 root 才有意义, 因此群组页 modal 不传这俩.
    // RichEditor 永远回传这俩 form 字段是为了 UI 回填, 不代表用户真改了
    if (isMyNote.value && !editGroupId.value) {
      patchData.visibility = data.visibility;
      patchData.sharedGroupIds = data.sharedGroupIds;
    }
    // PR #5: shared 笔记免锁路径外都必须带 lockToken (server 校验 + 自增清锁). 作者主视图改 root 多群免锁不带 lockToken
    if (isSharedNote.value && lockToken.value) {
      patchData.lockToken = lockToken.value;
    }
    // 所有笔记内容改动都带 version (private + shared 都做乐观锁防多设备旧覆盖新):
    //   - 持锁分支 (非作者 / 作者改 fork / 作者改 root 单群 / 作者群组页改 root 多群): 必须传, 后端校验后 ++ 清锁
    //   - 免锁分支 (作者改 private / 作者改 root 主视图多群): 改内容字段时校验, 不改内容时后端跳过 version 校验
    patchData.version = props.note.version || 1;
    // PR #7b: 透传群上下文给后端 fork 决策. editGroupId 为空 (主视图改) 时不传, 后端走"作者改 root 多群同步"语义.
    if (editGroupId.value) {
      patchData.editContext = { groupId: editGroupId.value };
    }
    await store.updateNote(props.note.id, patchData);
    // 提交成功 server 自动清锁, lockToken 失效, 心跳无效 → 停掉
    lockToken.value = null;
    stopHeartbeat();
    showInner.value = false;
  } catch (e: any) {
    const msg = e.message || '';
    if (msg.includes('version_conflict')) {
      toast.show('笔记已被其他人修改，请关闭后重新打开看最新版', 'error', 3500);
    } else if (msg.includes('lock_')) {
      toast.show('编辑锁已失效，请关闭后重新打开笔记', 'error', 3000);
    } else if (msg.includes('no_write_permission')) {
      // PR #5b: PATCH 时校验失败 (理论上 acquireLock 已拒, 但权限中途被撤等罕见 case 走到这)
      toast.show('编辑权限已被收回，请关闭后重新打开笔记', 'error', 3500);
    } else if (msg.includes('editContext_ambiguous')) {
      // PR #7b: 罕见歧义 case — 用户在多群里都能看到这条笔记, 主视图改没法判断 fork 到哪个群.
      // 引导用户从群组页面打开 (那条路径 editGroupId 自动取到, 无歧义)
      toast.show('这条笔记你在多个群里都能看到，请从某个群组页面打开编辑', 'error', 4500);
    } else if (msg.includes('note_not_in_group')) {
      // PR #7b: 笔记跟当前群上下文不匹配 (并发 case: 进入编辑时还在群里, 提交时该笔记已从群里撤下)
      toast.show('该笔记已不在当前群组，请关闭后重新打开', 'error', 4000);
    } else if (msg.includes('笔记不存在')) {
      // 笔记可能已被别的设备/用户 fork 走变孤儿或软删, 当前端 cache 里仍持有旧 id
      toast.show('笔记已不存在 (可能被其他人改动后归档), 请关闭后刷新页面', 'error', 4000);
    } else {
      toast.show('保存失败：' + (msg || '未知错误'), 'error', 3000);
    }
  } finally { saving.value = false; }
}

function startClose() {
  // 关闭瞬间用 cloneNode 把 vditor-wrapper 替换成静态 HTML 副本。
  // 用 chrome-devtools-mcp + MutationObserver 实测的 root cause:
  //   按 Esc 后 ~3ms 内 vditor.destroy() 就被触发(Vue Transition leave 期间 RichEditor
  //   并没有像预期那样保留到动画完成,destroy 把 toolbar + content 两个子节点直接从
  //   wrapper 里移除,然后剩下的 175ms 用户看到的就是 "空 wrapper + bottom bar 上移补位"
  //   一起 fade out。lock height / visibility / GPU layer 都被 vditor 内部 setAttribute 覆盖。
  // 偷天换日: clone 原 wrapper 当前 DOM 状态(含所有 style/class/子节点),replaceChild 让
  // staticCopy 占据 DOM 位置,原 wrapper 变游离节点。vditor 内部 destroy 操作的是游离节点
  // (不在 DOM 树),DOM 里的 staticCopy 是静态 HTML,modal fade 期间视觉完全稳定。
  if (modalCardRef.value) {
    const wrapper = modalCardRef.value.querySelector('.vditor-wrapper') as HTMLElement | null;
    if (wrapper && wrapper.parentElement) {
      const r = wrapper.getBoundingClientRect();
      const staticCopy = wrapper.cloneNode(true) as HTMLElement;
      staticCopy.style.height = r.height + 'px';
      staticCopy.style.width = r.width + 'px';
      staticCopy.style.flex = 'none';
      wrapper.parentElement.replaceChild(staticCopy, wrapper);
    }
  }
  showInner.value = false;
}

function tryClose() {
  if (editorRef.value?.isDirty) {
    showConfirm.value = true;
  } else {
    startClose();
  }
}

function confirmDiscard() {
  showConfirm.value = false;
  startClose();
}

function onAfterLeave() {
  emit('close');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  // stopImmediatePropagation 拦截所有后续 listener(包括 document 上 NoteDetail / 列表页等
  // 监听 Esc 做"退回上一层"的逻辑)。否则在详情页编辑时按 Esc,modal 关了又退到列表。
  e.stopImmediatePropagation();
  if (showConfirm.value) {
    showConfirm.value = false;
  } else {
    tryClose();
  }
}

// document level + capture 阶段挂载: 比 NoteDetail.onKeydown 的 bubble 阶段更早执行,
// 而且不依赖 focus 在 modal 内(focus 在 body 时事件也能被拦截)
onMounted(() => { document.addEventListener('keydown', onKeydown, true); });
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
  // PR #5: 关 modal 同时释放编辑锁 (fetch keepalive 保证 page unload 也能发出)
  releaseLockOnUnmount();
});
</script>

<template>
  <Teleport to="body">
    <!-- 全屏跟非全屏都走 modal-fade (蘑菇 2026-06-06 拍板):
         - 全屏: scale 动画期间 transform 让 fixed inset-0 被困在小窗口尺寸里, 走 fade 避免
         - 非全屏: scale(0.95)→scale(1) 期间 vditor 内 cursor 视觉位置跟着缩放 (cursor 实际在末尾但视觉飘半个字),
           Vditor IR 没法控制 cursor 抗 scale, caret-color: transparent 也救不回. 改 fade 彻底解决 focusEnd cursor 飘动. -->
    <Transition name="modal-fade" @after-leave="onAfterLeave">
    <div v-if="showInner" class="fixed inset-0 z-[var(--z-modal-edit)] flex items-center justify-center">
      <!-- Backdrop: 毛玻璃 -->
      <div class="absolute inset-0 bg-black/40 backdrop-blur-md" @click="tryClose" />

      <!-- Modal -->
      <div ref="modalCardRef" class="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[80vh] flex flex-col overflow-hidden ring-1 ring-black/5">
        <!-- Header -->
        <div class="flex items-center justify-between px-5 py-3 bg-gray-50/80">
          <span class="text-xs font-medium text-gray-500">编辑笔记</span>
          <div class="flex items-center gap-3">
            <span class="text-[11px] text-gray-400 hidden sm:inline">
              <kbd class="px-1.5 py-0.5 bg-gray-200/60 rounded text-[10px]">Esc</kbd> 关闭
            </span>
            <button @click="tryClose" class="p-1 rounded-lg hover:bg-gray-200/60 text-gray-400 transition-colors">
              <PhXCircle size="1rem" weight="fill" />
            </button>
          </div>
        </div>

        <!-- Shared RichEditor -->
        <div class="overflow-hidden">
          <RichEditor
            ref="editorRef"
            :initial-content="note.content"
            :initial-type="note.type"
            :initial-tags="note.tags || []"
            :initial-fullscreen="initialFullscreen"
            :initial-visibility="(note as any).visibility || 'private'"
            :initial-shared-group-ids="(note as any).sharedGroupIds || []"
            :focus-end="true"
            :max-height="450"
            :lock-type="!isMyNote"
            :hide-tags="!isMyNote"
            submit-label="保存"
            @submit="onSubmit"
          />
        </div>
      </div>

      <!-- 未保存确认弹窗 -->
      <Transition enter-active-class="transition duration-150 ease-out" enter-from-class="opacity-0 scale-95"
        leave-active-class="transition duration-100 ease-in" leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
        <div v-if="showConfirm" class="absolute inset-0 z-[var(--z-sticky)] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/20" @click="showConfirm = false" />
          <div class="relative bg-white rounded-xl shadow-xl p-6 w-80 text-center">
            <p class="text-sm text-gray-700 mb-1">内容尚未保存</p>
            <p class="text-xs text-gray-400 mb-5">关闭后未保存的修改将丢失</p>
            <div class="flex gap-3 justify-center">
              <button @click="showConfirm = false"
                class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
                继续编辑
              </button>
              <button @click="confirmDiscard"
                class="px-4 py-1.5 text-xs rounded-lg text-white transition-colors"
                style="background: rgb(var(--c-accent-dark))">
                放弃修改
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
    </Transition>

    <!-- PR #9 申请编辑权对话框: 没 write 权限的人点编辑触发, 不显示编辑器内容 -->
    <Transition name="modal-fade">
    <div v-if="showRequestPerm" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30" @click="cancelEditRequest" />
      <div class="relative bg-white rounded-xl shadow-xl p-6 w-96">
        <p class="text-sm text-gray-700 font-medium mb-1">申请编辑权限</p>
        <p class="text-xs text-gray-400 mb-3">
          {{ requestPermLabel === 'admin' ? '这条笔记仅管理员可编辑' : '这条笔记所有人可编辑' }}, 提交申请后由作者或群管理员审批
        </p>
        <textarea v-model="requestPermMessage" rows="3" maxlength="500"
          placeholder="附上申请理由 (可选, 最多 500 字)"
          spellcheck="false"
          class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs leading-relaxed outline-none focus:border-primary resize-none text-gray-600" />
        <div class="flex gap-2 justify-end mt-4">
          <button @click="cancelEditRequest"
            class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">取消</button>
          <button @click="submitEditRequest" :disabled="submittingRequest"
            class="px-4 py-1.5 text-xs rounded-lg bg-primary-light text-primary-dark hover:bg-primary/20 disabled:opacity-50 transition-colors font-medium">
            {{ submittingRequest ? '提交中...' : '提交申请' }}
          </button>
        </div>
      </div>
    </div>
    </Transition>
  </Teleport>
</template>
