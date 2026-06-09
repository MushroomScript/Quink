import { ref } from 'vue';
import { api, type InvitePreview, type ApplyInviteResult } from '@/api';
import { useGroupsStore } from '@/stores/groups';

// 加入群组核心逻辑: getInvite 预览 + applyInvite 申请.
// 不负责 toast / router 跳转 / 关弹窗, 由调用方处理 (Invite.vue 跟 GroupActionModal 交互不同).
// 加入成功 (status === 'joined' / 'already_member') 自动调 store.loadGroups() 同步 sidebar 群列表.
//
// loadPreview 失败时只写 errorMsg 不 throw, 调用方读 errorMsg 显示.
// doApply 失败时 throw, 由调用方决定 toast 或其他反馈.
//
// race 防护: 用户连续粘贴不同 token 时, 旧请求晚于新请求 resolve 不能覆盖新预览.
// 每次 loadPreview 在 closure 里记 reqToken, response 回来时跟 currentReqToken 比, 不匹配丢弃.
// reset() 把 currentReqToken 设 null 直接作废 in-flight 请求.
//
// 用法:
//   const { preview, loading, errorMsg, applying, result, loadPreview, doApply, reset } = useInviteApply();
//   await loadPreview(token);
//   if (errorMsg.value) return;  // 读 errorMsg 判断成败
//   const res = await doApply(token);
export function useInviteApply() {
  const groups = useGroupsStore();
  const preview = ref<InvitePreview | null>(null);
  const loading = ref(false);
  const errorMsg = ref('');
  const applying = ref(false);
  const result = ref<ApplyInviteResult | null>(null);

  // 标记最后一次 loadPreview 的 token, response 回来时比对, 旧请求被新请求覆盖时丢弃
  let currentReqToken: string | null = null;

  async function loadPreview(token: string) {
    currentReqToken = token;
    loading.value = true;
    errorMsg.value = '';
    preview.value = null;
    try {
      const res = await api.getInvite(token);
      if (currentReqToken !== token) return;  // 已被新请求覆盖
      preview.value = res.data;
    } catch (e: any) {
      if (currentReqToken !== token) return;
      errorMsg.value = e?.message || '邀请链接无效';
    } finally {
      if (currentReqToken === token) loading.value = false;
    }
  }

  async function doApply(token: string): Promise<ApplyInviteResult> {
    if (!preview.value) throw new Error('请先加载邀请预览');
    if (applying.value) throw new Error('正在申请中');
    applying.value = true;
    try {
      const res = await api.applyInvite(token);
      result.value = res.data;
      if (res.data.status === 'joined' || res.data.status === 'already_member') {
        await groups.loadGroups();
      }
      return res.data;
    } finally {
      applying.value = false;
    }
  }

  function reset() {
    currentReqToken = null;  // 作废任何 in-flight loadPreview
    preview.value = null;
    loading.value = false;
    errorMsg.value = '';
    applying.value = false;
    result.value = null;
  }

  return {
    preview, loading, errorMsg, applying, result,
    loadPreview, doApply, reset,
  };
}

// 把用户输入 (邀请码 / 完整邀请链接 / 链接末尾带 query / hash) 解析成 token.
// nanoid URL-safe alphabet: [A-Za-z0-9_-], INVITE_TOKEN_LEN = 16 (跟 packages/server/src/routes/groups.ts 同步).
// 解析失败返回 null.
export function parseInviteInput(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // 优先当 URL 试: /invite/{token} 取最后一段 path
  try {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || '';
    if (isValidInviteToken(last)) return last;
  } catch {
    // 不是合法 URL, 落到纯 token 分支
  }
  if (isValidInviteToken(s)) return s;
  return null;
}

function isValidInviteToken(s: string): boolean {
  return /^[A-Za-z0-9_-]{16}$/.test(s);
}
