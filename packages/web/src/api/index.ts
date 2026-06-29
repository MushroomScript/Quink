import { backendBaseUrl } from '@/utils/backendUrl';

// dev: backendBaseUrl() 返回 http://localhost:38999 → 所有 API 直连 backend, 绕开 vite proxy 防 socket 池泄漏
// prod: backendBaseUrl() 返回 '' → 走相对路径 /api/* 同 origin (nginx 反代 / 一体化容器)
// 之前只让 SSE / AI chat 长连接绕 proxy, 普通 API 走 proxy. 但 Vite http-proxy 偶发 socket 泄漏会让所有 API 卡死,
// 必须关 Electron 重启才能救. 现在普通 API 也直连, 彻底告别"用户每次卡都重启"体验.
// 代价: 跨 origin + Authorization header 触发 OPTIONS preflight, 每请求 +50ms RTT. hono cors() 已放行, 不会报错.
const BASE = '/api';
function fullUrl(path: string) { return `${backendBaseUrl()}${BASE}${path}`; }

function getToken(): string | null {
  return localStorage.getItem('quink_token');
}

export function setToken(token: string | null) {
  if (token) {
    localStorage.setItem('quink_token', token);
  } else {
    localStorage.removeItem('quink_token');
  }
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

// 防止多个 401 同时触发重复跳转
let isRedirecting = false;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  // 每 tab 唯一 clientId, server publish 时附在事件 payload, 前端 SSE handler 跳过自己发的事件 (本设备已直接 mutate UI 不需要 SSE 二次触发)
  try {
    const { getClientId } = await import('@/utils/clientId');
    headers['X-Quink-Client-Id'] = getClientId();
  } catch { /* 兜底 */ }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
  let res: Response;
  try {
    res = await fetch(fullUrl(url), { headers, ...options, signal: controller.signal });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('请求超时');
    throw err;
  }
  clearTimeout(timeout);

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const msg = err.error || res.statusText;

    // 401 且不是登录/注册请求 → 跳转到登录页
    const isAuthRequest = url.startsWith('/auth/login') || url.startsWith('/auth/register');
    if (res.status === 401 && !isAuthRequest) {
      setToken(null);
      if (!isRedirecting && window.location.pathname !== '/login') {
        isRedirecting = true;
        window.location.href = '/login';
      }
    }

    throw new Error(msg);
  }
  return res.json();
}

// 登录成功后重置标记
export function resetRedirectFlag() {
  isRedirecting = false;
}

// ── Types ──

export interface User {
  id: string;
  username: string;
  nickname: string;
  avatar: string | null;
  preferences: Record<string, any>;
}

export interface Note {
  id: string;
  // 作者 userId (群组共享: shared 笔记群成员能看到别人发的, 需区分作者跟自己)
  userId?: string;
  content: string;
  summary: string | null;
  category: string | null;
  tags: string[];
  // 命名约定: quink=灵感, note=笔记, todo=待办. link 类型已废弃删
  type: 'quink' | 'note' | 'todo';
  todoStatus: 'pending' | 'done' | null;
  // todoDue / todoRemindSentAt / todoRemindRrule 三字段已删. 提醒走 note_personal_reminders / note_group_reminders
  aiProcessed: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  // 群组共享: 'private' (默认 仅作者) / 'shared' (分享到 sharedGroupIds 列出的群)
  visibility?: 'private' | 'shared';
  sharedGroupIds?: string[];
  // 群组 feed (GET /api/groups/:id/notes) 才返回, 给 NoteCard 显示发布人头像 + 排序
  sharedAt?: string;
  authorNickname?: string;
  authorAvatar?: string | null;
  // 编辑锁 + 乐观锁版本. shared 笔记 PATCH 时必须带 version, 失败 409 让客户端重拉重试
  version?: number;
  editLockBy?: string | null;
  editLockExpiresAt?: string | null;
  // 编辑权限分级 (仅 shared 笔记用): admin (默认, 仅作者+群 owner/admin 能改) / all (所有 active member 能改)
  // 作者本人永远能改 (不在 enum 里). 没权限的可通过 POST /:id/edit-request 申请永久授权.
  editPermission?: 'admin' | 'all';
  // 群内独立置顶 (仅 GET /api/groups/:id/notes 返回, 跟 pinned 作者全局置顶完全独立). owner/admin 操作
  groupPinned?: boolean;
  // 表情 reaction + 评论. 仅 shared 笔记返回. 列表 API 已 enrich (NoteCard 直接渲染), 详情走专用 API 增量更新.
  // reactionSummary 按白名单 5 个 emoji 固定顺序 (count=0 也含); NoteCard 按需过滤 count>0 显示, ReactionBar 永远渲染 5 个
  reactionSummary?: NoteReactionSummaryItem[];
  commentCount?: number;
  // COW 分叉: parentNoteId 非 null = fork 出来的笔记 (该群专属版本), null = root note (作者初版, 可能仍连多群).
  // NoteCard / NoteDetail / NoteEditModal 用这字段判断展示"本群独占版" vs "N 群共享版" 标.
  parentNoteId?: string | null;
  // 编辑历史计数: 非作者编辑次数 (作者改不计). NoteCard 显示"X 人编辑过" 胶囊, 详情走 getNoteEditHistory 拉完整列表
  editorCount?: number;
  // 当前用户对本笔记是否有写权限. shared 笔记由后端 enrich (isAuthor || editPermission='all' || 在共享群是 admin/owner || 在 grants 白名单).
  // private 笔记不返回此字段 (作者本人无视, 别人也读不到), NoteCard 前端用 isMyNote || !isShared || canWrite 预判.
  canWrite?: boolean;
}

// 编辑历史一条: NoteDetail "X 人编辑过" popover 列编辑者用. 后端 join users 给 nickname/avatar.
export interface NoteEditHistoryRow {
  id: string;
  userId: string;
  editedAt: string;
  nickname: string | null;
  avatar: string | null;
}

// 单个 emoji 的反应汇总. mine = 我自己加过该 emoji (点击 toggle 移除).
export interface NoteReactionSummaryItem {
  emoji: string;
  count: number;
  mine: boolean;
}

// 评论. 后端 join users 给 nickname / avatar. parentId 走单层 thread normalize (顶层 null; 回复任意级最终归到根 id)
export interface NoteComment {
  id: string;
  noteId: string;
  userId: string;
  parentId: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
  userNickname: string | null;
  userAvatar: string | null;
}

// 编辑权限申请记录
export interface NoteEditRequest {
  id: string;
  noteId?: string;
  userId: string;
  status: 'pending' | 'approved' | 'rejected' | 'canceled';
  message: string | null;
  createdAt: string;
  handledAt: string | null;
  handledBy: string | null;
  // 列接口 join users 返回的辅助字段
  nickname?: string | null;
  avatar?: string | null;
}

// 编辑权限白名单 (永久授权)
export interface NoteEditGrant {
  userId: string;
  grantedAt: string;
  grantedBy: string;
  nickname?: string | null;
  avatar?: string | null;
}

// 群级汇总: 该群所有共享笔记的 pending 编辑申请 / 已授权 (含笔记 preview + 申请人 + 作者信息)
export interface GroupNoteEditRequestRow {
  id: string;
  noteId: string;
  userId: string;
  status: 'pending' | 'approved' | 'rejected' | 'canceled';
  message: string | null;
  createdAt: string;
  requesterNickname: string | null;
  requesterAvatar: string | null;
  notePreview: string;
  noteAuthorId: string;
  authorNickname: string | null;
}

export interface GroupNoteEditGrantRow {
  noteId: string;
  userId: string;
  grantedAt: string;
  grantedBy: string;
  nickname: string | null;
  avatar: string | null;
  notePreview: string;
  noteAuthorId: string;
  authorNickname: string | null;
}

// 笔记列表过滤 scope. 跟 stores/notes.ts 的 ViewState.scope 同 5 档:
//   mine          默认, 作者本人全部含 shared
//   private       仅作者本人 private
//   others_shared 作者本人 private + 他人共享给我所在群的 shared
//   shared        仅他人共享给我所在群的 shared, 偏好不映射, 兼容旧调用方
//   all           mine + 他人共享给我所在群的 shared
//   group:<id>    某群可见笔记
export type NotesScope =
  | 'mine'
  | 'private'
  | 'others_shared'
  | 'shared'
  | 'all'
  | `group:${string}`;

export type ReminderChannelType =
  | 'browser' | 'email' | 'bark' | 'wecom_bot' | 'dingtalk_bot' | 'feishu_bot' | 'telegram' | 'webhook';

export interface ReminderChannel {
  id: string;
  userId: string;
  type: ReminderChannelType;
  name: string;
  config: Record<string, any>;
  enabled: boolean;
  // 通知类型白名单. null/空=全收 (兼容老 row). UI 在 Settings 提醒页编辑
  types: string[] | null;
  createdAt: string;
}

export type GroupRole = 'owner' | 'admin' | 'member';

export interface Group {
  id: string;
  ownerId: string;
  name: string;
  avatar: string | null;
  inviteToken: string | null;
  inviteExpiresAt: string | null;
  autoJoin: boolean;
  createdAt: string;
  memberCount: number;
  myRole: GroupRole | null;
  // 群公告 (markdown, owner/admin 可编辑)
  announcement?: string | null;
  announcementUpdatedAt?: string | null;
  announcementUpdatedBy?: string | null;
  announcementUpdatedByNickname?: string | null;
}

export interface GroupMemberInfo {
  userId: string;
  role: GroupRole;
  joinedAt: string;
  username: string;
  nickname: string;
  avatar: string | null;
  // SSE 连接活跃即视为在线; bus.ts presence 追踪. 隐身用户对他人 online 永远为 false
  online?: boolean;
  // 仅本人 server 返此字段 (其他人看不到我隐身/我看不到别人隐身设置)
  hidePresence?: boolean;
}

export interface GroupDetail extends Group {
  members: GroupMemberInfo[];
}

export interface GroupJoinRequest {
  id: string;
  userId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  createdAt: string;
  handledAt: string | null;
  handledBy: string | null;
  applicant: { username: string; nickname: string; avatar: string | null };
}

// 公开邀请页返回 (不需登录可见的群组简介)
export interface InvitePreview {
  id: string;
  name: string;
  avatar: string | null;
  memberCount: number;
  autoJoin: boolean;
  inviteExpiresAt: string | null;
}

// 申请加入返回: pending = 等审批, joined = 自动加入模式直接进, already_member = 已经是成员幂等
export type ApplyInviteResult =
  | { status: 'pending'; requestId: string; groupId: string }
  | { status: 'joined'; groupId: string }
  | { status: 'already_member'; groupId: string };

export interface PaginatedResponse<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number };
}

// 系统只支持一级分类, child 概念废弃 (parentId / children 字段移除)
export interface Category {
  id: number;
  name: string;
  icon: string | null;
  sortOrder: number;
}

export interface AiConfigItem {
  id: string;
  userId: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  isDefault: boolean;
  createdAt: string;
}

export interface AiPromptItem {
  feature: string;
  label: string;
  prompt: string;
  isCustom: boolean;
}

// ── API ──

export const api = {
  // Auth
  register(data: { username: string; password: string; nickname: string }) {
    return request<{ data: { token: string; user: User } }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  login(data: { username: string; password: string }) {
    return request<{ data: { token: string; user: User } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  getMe() {
    return request<{ data: User }>('/auth/me');
  },

  updateProfile(data: { nickname?: string; avatar?: string; preferences?: Record<string, any> }) {
    return request<{ data: User }>('/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  changePassword(oldPassword: string, newPassword: string) {
    return request<{ message: string }>('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    });
  },

  // 主动登出所有设备 (含本机). 后端 tokenVersion++ 让旧 token 立即失效
  logoutAllDevices() {
    return request<{ message: string }>('/auth/logout-all-devices', { method: 'POST' });
  },

  // Notes
  getNotes(params?: Record<string, string>) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<PaginatedResponse<Note>>(`/notes${qs}`);
  },

  // Trash
  getTrash() {
    return request<{ data: Note[] }>('/notes/trash');
  },
  restoreNote(id: string) {
    return request<{ message: string }>(`/notes/trash/${id}/restore`, { method: 'POST' });
  },
  permanentDeleteNote(id: string) {
    return request<{ message: string }>(`/notes/trash/${id}`, { method: 'DELETE' });
  },
  emptyTrash() {
    return request<{ message: string }>('/notes/trash', { method: 'DELETE' });
  },

  getTags() {
    return request<{ data: string[] }>('/notes/tags');
  },

  getNote(id: string) {
    return request<{ data: Note }>(`/notes/${id}`);
  },

  createNote(data: { content: string; type?: string; category?: string; tags?: string[]; visibility?: 'private' | 'shared'; sharedGroupIds?: string[] }) {
    return request<{ data: Note }>('/notes', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // PATCH 返回可能含 forked: true + forkedFromNoteId (非作者改 / 作者从群组页改 root 多群 → fork 写入).
  // store 收到 forked 触发本 view fetchNotes (新 fork 出现 + 老 note share 状态变化), 详见 stores/notes.ts updateNote.
  updateNote(id: string, data: Partial<Note> & { lockToken?: string; editContext?: { groupId?: string }; skipTimestamp?: boolean }) {
    return request<{ data: Note; forked?: boolean; forkedFromNoteId?: string }>(`/notes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  // 返回 sharedGroupIds (空数组 = private 笔记). 给 store.deleteNote 派 quink-group-notes-changed
  // 事件让操作者自己的 GroupDetail 重拉 (本地 ref 自管, 收不到自己的 SSE)
  // groupId 参数: admin 删别人共享笔记时从群组上下文传, 让后端写 deletedInGroupId 进群回收站
  deleteNote(id: string, opts?: { groupId?: string }) {
    const q = opts?.groupId ? `?groupId=${encodeURIComponent(opts.groupId)}` : '';
    return request<{ message: string; sharedGroupIds: string[] }>(`/notes/${id}${q}`, { method: 'DELETE' });
  },

  // 群组回收站 (owner+admin 列 / 恢复; 仅 owner 永久删 / 清空)
  getGroupTrash(groupId: string) {
    return request<{ data: any[]; retentionDays: number }>(`/groups/${groupId}/trash`);
  },
  restoreFromGroupTrash(groupId: string, noteId: string) {
    return request<{ message: string }>(`/groups/${groupId}/trash/${noteId}/restore`, { method: 'POST' });
  },
  permanentDeleteFromGroupTrash(groupId: string, noteId: string) {
    return request<{ message: string }>(`/groups/${groupId}/trash/${noteId}`, { method: 'DELETE' });
  },
  emptyGroupTrash(groupId: string) {
    return request<{ message: string; count: number }>(`/groups/${groupId}/trash`, { method: 'DELETE' });
  },

  // 编辑锁: 仅 shared 笔记走. 返回 lockToken + expiresAt; 409 已被别人锁返回 lockByNickname
  acquireNoteLock(id: string) {
    return request<{ data: { lockToken: string; expiresAt: string } }>(`/notes/${id}/lock`, {
      method: 'POST',
    });
  },

  heartbeatNoteLock(id: string, lockToken: string) {
    return request<{ data: { expiresAt: string } }>(`/notes/${id}/lock/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ lockToken }),
    });
  },

  // 注意: NoteEditModal 真实释放走 navigator.sendBeacon (页面卸载时同步发出, fetch 异步会被取消),
  // 这里的 fetch 版只给"主动取消编辑"场景, sendBeacon 路径直接拼 URL + token query, 见 NoteEditModal
  releaseNoteLock(id: string) {
    return request<{ data: { released: boolean } }>(`/notes/${id}/lock`, { method: 'DELETE' });
  },

  // 编辑权限分级: 申请编辑权 / 审批 / 撤销 (改 editPermission 走 updateNote 的 editPermission 字段)
  requestNoteEditPermission(id: string, message?: string) {
    return request<{ data: NoteEditRequest }>(`/notes/${id}/edit-request`, {
      method: 'POST',
      body: JSON.stringify({ message: message || null }),
    });
  },

  approveNoteEditRequest(noteId: string, requestId: string) {
    return request<{ data: { message: string } }>(`/notes/${noteId}/edit-requests/${requestId}/approve`, {
      method: 'POST',
    });
  },

  rejectNoteEditRequest(noteId: string, requestId: string) {
    return request<{ data: { message: string } }>(`/notes/${noteId}/edit-requests/${requestId}/reject`, {
      method: 'POST',
    });
  },

  listNoteEditRequests(id: string) {
    return request<{ data: NoteEditRequest[] }>(`/notes/${id}/edit-requests`);
  },

  listNoteEditGrants(id: string) {
    return request<{ data: NoteEditGrant[] }>(`/notes/${id}/edit-grants`);
  },

  revokeNoteEditGrant(noteId: string, userId: string) {
    return request<{ data: { message: string } }>(`/notes/${noteId}/edit-grants/${userId}`, {
      method: 'DELETE',
    });
  },

  // 拉编辑历史. NoteDetail "X 人编辑过" 胶囊 popover 用. 仅非作者编辑写历史, 故作者改不出现在列表里.
  getNoteEditHistory(id: string) {
    return request<{ data: NoteEditHistoryRow[] }>(`/notes/${id}/edit-history`);
  },

  // 另存为副本. 复制 content + 引用原作者抬头 + 归属操作人 + visibility=private.
  // tags / category / pinned / todoStatus / todoDue / parentNoteId 都不复制. 通知原作者 SSE note-duplicated.
  duplicateNote(id: string) {
    return request<{ data: Note }>(`/notes/${id}/duplicate`, { method: 'POST' });
  },

  // 设置我在某群的隐身状态. 隐身: 我上下线不给群其他成员推 presence-changed (但我仍能收所有事件)
  setGroupPresenceMode(groupId: string, hidePresence: boolean) {
    return request<{ data: { hidePresence: boolean } }>(`/groups/${groupId}/members/me/presence-mode`, {
      method: 'PATCH',
      body: JSON.stringify({ hidePresence }),
    });
  },

  // 群级汇总 (作者+admin 看), 给群组详情页"编辑申请管理"面板用
  listGroupEditRequests(groupId: string) {
    return request<{ data: GroupNoteEditRequestRow[] }>(`/groups/${groupId}/note-edit-requests`);
  },

  listGroupEditGrants(groupId: string) {
    return request<{ data: GroupNoteEditGrantRow[] }>(`/groups/${groupId}/note-edit-grants`);
  },

  // Reactions: toggle 自己的 reaction + 拉汇总. 仅 shared 笔记可用.
  toggleNoteReaction(noteId: string, emoji: string) {
    return request<{ data: { action: 'added' | 'removed'; summary: NoteReactionSummaryItem[] } }>(`/notes/${noteId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    });
  },

  listNoteReactions(noteId: string) {
    return request<{ data: NoteReactionSummaryItem[] }>(`/notes/${noteId}/reactions`);
  },

  // Comments: 单层 thread (parentId 后端 normalize). 软删本人+作者+admin 可操作; 编辑仅本人.
  listNoteComments(noteId: string) {
    return request<{ data: NoteComment[] }>(`/notes/${noteId}/comments`);
  },

  createNoteComment(noteId: string, content: string, parentId?: string | null) {
    return request<{ data: NoteComment }>(`/notes/${noteId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content, parentId: parentId ?? null }),
    });
  },

  updateNoteComment(noteId: string, commentId: string, content: string) {
    return request<{ data: NoteComment }>(`/notes/${noteId}/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    });
  },

  deleteNoteComment(noteId: string, commentId: string) {
    return request<{ data: { message: string } }>(`/notes/${noteId}/comments/${commentId}`, {
      method: 'DELETE',
    });
  },

  // Categories
  getCategories() {
    return request<{ data: Category[] }>('/categories');
  },

  createCategory(data: { name: string }) {
    return request<{ data: Category }>('/categories', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  deleteCategory(id: number) {
    return request<{ message: string }>(`/categories/${id}`, { method: 'DELETE' });
  },

  reorderCategories(data: { orderedIds: number[] }) {
    return request<{ message: string }>('/categories/reorder', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Upload
  async uploadAvatar(file: File): Promise<{ data: { url: string } }> {
    return this.uploadFile(file, 'avatar');
  },

  async uploadFile(
    file: File,
    endpoint: 'avatar' | 'file' = 'file',
    options?: {
      displayName?: string;
      folderId?: string | null;
      // XHR upload progress 回调, fetch + FormData 不支持 upload progress, 所以这里用 XMLHttpRequest
      onProgress?: (received: number, total: number) => void;
      // AbortSignal 支持外部取消
      signal?: AbortSignal;
    }
  ): Promise<{ data: { url: string; filename?: string; type?: string; category?: string; size?: number } }> {
    const formData = new FormData();
    formData.append('file', file);
    if (options?.displayName) formData.append('displayName', options.displayName);
    if (options?.folderId) formData.append('folderId', options.folderId);

    const token = getToken();
    // 用 XMLHttpRequest 因为只有 XHR 才能监听 upload 进度. fetch + FormData 拿不到上传 byte 数
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', fullUrl(`/upload/${endpoint}`));
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      // 注意是 xhr.upload.onprogress 不是 xhr.onprogress(后者是下载进度)
      if (options?.onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) options.onProgress!(e.loaded, e.total);
        };
      }

      // AbortSignal 集成: signal.abort 时主动 xhr.abort()
      const onAbort = () => xhr.abort();
      if (options?.signal) {
        if (options.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        options.signal.addEventListener('abort', onAbort);
      }

      xhr.onload = () => {
        if (options?.signal) options.signal.removeEventListener('abort', onAbort);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            reject(new Error('响应解析失败'));
          }
        } else {
          let errMsg = xhr.statusText;
          try {
            const errBody = JSON.parse(xhr.responseText);
            if (errBody.error) errMsg = errBody.error;
          } catch {}
          reject(new Error(errMsg));
        }
      };
      xhr.onerror = () => {
        if (options?.signal) options.signal.removeEventListener('abort', onAbort);
        reject(new Error('网络错误'));
      };
      xhr.onabort = () => {
        if (options?.signal) options.signal.removeEventListener('abort', onAbort);
        reject(new DOMException('Aborted', 'AbortError'));
      };

      xhr.send(formData);
    });
  },

  // Files
  getFiles() {
    return request<{ data: Array<{ id: string; filename: string; url: string; mimeType: string; category: string; size: number; createdAt: string; folderId: string | null }> }>('/upload/files');
  },

  deleteFile(id: string) {
    return request<{ message: string }>(`/upload/files/${id}`, { method: 'DELETE' });
  },

  // 重命名: 改 DB 的 display filename + 后端同步扫描所有笔记把 [oldName](url) markdown link label 改成 [newName](url)
  renameFile(id: string, filename: string) {
    return request<{ data: { id: string; filename: string; url: string } }>(`/upload/files/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ filename }),
    });
  },

  // 批量移动文件到指定文件夹 (folderId null = 移到根目录)
  moveFiles(ids: string[], folderId: string | null) {
    return request<{ message: string; count: number }>('/upload/files/move', {
      method: 'POST',
      body: JSON.stringify({ ids, folderId }),
    });
  },

  // 批量移动文件和/或文件夹到指定文件夹. 文件夹移动会校验循环 (不能移到自己 / 自己子孙)
  moveItems(payload: { fileIds?: string[]; folderIds?: string[]; targetFolderId: string | null }) {
    return request<{ message: string; count: number }>('/upload/items/move', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Folders
  getFolders() {
    return request<{ data: Array<{ id: string; name: string; parentId: string | null; createdAt: string }> }>('/upload/folders');
  },

  createFolder(name: string, parentId: string | null) {
    return request<{ data: { id: string; name: string; parentId: string | null; createdAt: string } }>('/upload/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId }),
    });
  },

  renameFolder(id: string, name: string) {
    return request<{ data: { id: string; name: string } }>(`/upload/folders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  },

  deleteFolder(id: string, deleteFiles = false) {
    return request<{ message: string }>(`/upload/folders/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ deleteFiles }),
    });
  },

  // 文件夹打包下载: 用 fetch 带 Auth header 拿 zip blob, 触发浏览器下载
  // (不能用 <a href> 因为 endpoint 受 authMiddleware 保护需要 Bearer token, <a href> 没法带 header)
  // signal 可选: 调用方传 AbortController.signal 让 view unmount 时取消进行中的下载
  async downloadFolder(folder: { id: string; name: string }, signal?: AbortSignal): Promise<void> {
    const token = getToken();
    const res = await fetch(fullUrl(`/upload/folders/${folder.id}/download`), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${folder.name}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // AI Configs
  getAiConfigs() {
    return request<{ data: AiConfigItem[] }>('/ai/configs');
  },
  createAiConfig(data: Omit<AiConfigItem, 'id' | 'userId' | 'createdAt'>) {
    return request<{ data: AiConfigItem }>('/ai/configs', { method: 'POST', body: JSON.stringify(data) });
  },
  updateAiConfig(id: string, data: Partial<AiConfigItem>) {
    return request<{ data: AiConfigItem }>(`/ai/configs/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  },
  deleteAiConfig(id: string) {
    return request<{ message: string }>(`/ai/configs/${id}`, { method: 'DELETE' });
  },
  testAiConfig(configId: string) {
    return request<{ data: { success: boolean; message: string } }>('/ai/test', { method: 'POST', body: JSON.stringify({ configId }) });
  },

  // AI Prompts
  getAiPrompts() {
    return request<{ data: Record<string, AiPromptItem> }>('/ai/prompts');
  },
  updateAiPrompt(feature: string, prompt: string) {
    return request<{ data: { feature: string; prompt: string } }>(`/ai/prompts/${feature}`, { method: 'PATCH', body: JSON.stringify({ prompt }) });
  },
  resetAiPrompt(feature: string) {
    return request<{ data: { feature: string; prompt: string } }>(`/ai/prompts/${feature}`, { method: 'DELETE' });
  },

  // AI Process
  aiProcess(feature: string, content: string, prompt?: string) {
    return request<{ data: { result: string } }>('/ai/process', {
      method: 'POST',
      body: JSON.stringify({ feature, content, prompt }),
    });
  },

  async transcribe(audioBlob: Blob): Promise<{ data: { text: string } }> {
    const formData = new FormData();
    // 推断后缀,让 Whisper API 拿到正确格式提示(server 端会用 blob.type 决定 Whisper 上传的 ext)
    const ext = audioBlob.type.includes('mp4') ? 'm4a'
              : audioBlob.type.includes('ogg') ? 'ogg'
              : 'webm';
    formData.append('file', audioBlob, `audio.${ext}`);
    const token = getToken();
    const res = await fetch(fullUrl('/ai/transcribe'), {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!res.ok) throw new Error((await res.json()).error || '语音识别失败');
    return res.json();
  },

  getIatUrl() {
    return request<{ data: { url: string; appId: string } }>('/ai/iat-url');
  },

  // Export / Import
  async exportData(params?: { noteIds?: string[]; category?: string; dateFrom?: string; dateTo?: string; type?: string; tag?: string }): Promise<void> {
    const token = getToken();
    const qs = new URLSearchParams();
    if (params?.noteIds?.length) qs.set('noteIds', params.noteIds.join(','));
    if (params?.category) qs.set('category', params.category);
    if (params?.dateFrom) qs.set('dateFrom', params.dateFrom);
    if (params?.dateTo) qs.set('dateTo', params.dateTo);
    if (params?.type) qs.set('type', params.type);
    if (params?.tag) qs.set('tag', params.tag);
    const query = qs.toString();
    const res = await fetch(fullUrl('/data' + (query ? '?' + query : '')), {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '导出失败' }));
      throw new Error(err.error || '导出失败');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quink-export-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  },

  async importData(file: File): Promise<{ data: { imported: number; total: number } }> {
    const formData = new FormData();
    formData.append('file', file);
    const token = getToken();
    const res = await fetch(fullUrl('/data'), {
      method: 'POST',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '导入失败' }));
      throw new Error(err.error || '导入失败');
    }
    return res.json();
  },

  // AI Chat
  aiChat(question: string) {
    return request<{ data: { result: string } }>('/ai/chat', { method: 'POST', body: JSON.stringify({ question }) });
  },

  // Voice Transcription
  transcribeAsync(audioUrl: string) {
    return request<{ data: { id: string; audioUrl: string; text: string; status: string } }>('/ai/transcribe-async', { method: 'POST', body: JSON.stringify({ audioUrl }) });
  },
  getTranscription(audioUrl: string) {
    return request<{ data: { id: string; audioUrl: string; text: string; status: string } | null }>(`/ai/transcription?audioUrl=${encodeURIComponent(audioUrl)}`);
  },

  // AI Conversations
  getConversations(params?: Record<string, string>) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return request<{ data: Array<{ id: string; title: string; createdAt: string; updatedAt: string }> }>(`/ai/chat/conversations${qs}`);
  },
  createConversation() {
    return request<{ data: { id: string; title: string; createdAt: string; updatedAt: string } }>('/ai/chat/conversations', { method: 'POST' });
  },
  updateConversation(id: string, data: { title: string }) {
    return request<{ data: { id: string; title: string } }>(`/ai/chat/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  },
  deleteConversation(id: string) {
    return request<{ message: string }>(`/ai/chat/conversations/${id}`, { method: 'DELETE' });
  },
  getMessages(conversationId: string) {
    return request<{ data: Array<{ id: string; role: string; content: string; sources: string[]; createdAt: string }> }>(`/ai/chat/conversations/${conversationId}/messages`);
  },
  deleteMessagesFrom(conversationId: string, msgId: string) {
    return request<{ message: string }>(`/ai/chat/conversations/${conversationId}/messages/${msgId}`, { method: 'DELETE' });
  },

  // Stats
  getStats() {
    return request<{ data: { totalNotes: number; totalTodos: number; pendingTodos: number } }>('/stats');
  },

  // Reminder Channels
  getReminderChannels() {
    return request<{ data: ReminderChannel[] }>('/reminder-channels');
  },
  createReminderChannel(data: { type: ReminderChannelType; name: string; config: Record<string, any>; enabled?: boolean; types?: string[] | null }) {
    return request<{ data: ReminderChannel }>('/reminder-channels', { method: 'POST', body: JSON.stringify(data) });
  },
  updateReminderChannel(id: string, data: Partial<Pick<ReminderChannel, 'name' | 'config' | 'enabled' | 'types'>>) {
    return request<{ data: ReminderChannel }>(`/reminder-channels/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  },
  deleteReminderChannel(id: string) {
    return request<{ message: string }>(`/reminder-channels/${id}`, { method: 'DELETE' });
  },
  // 立即发测试消息, 失败抛 Error 含原因 (config 拼写错 / token 无效等)
  testReminderChannel(id: string) {
    return request<{ message: string }>(`/reminder-channels/${id}/test`, { method: 'POST' });
  },

  // Groups (群组共享: 任何注册用户可建群, 邀请链接默认走申请审批模式)
  getGroups() {
    return request<{ data: Group[] }>('/groups');
  },
  createGroup(data: { name: string; avatar?: string | null; autoJoin?: boolean }) {
    return request<{ data: Group }>('/groups', { method: 'POST', body: JSON.stringify(data) });
  },
  getGroup(id: string) {
    return request<{ data: GroupDetail }>(`/groups/${id}`);
  },
  // 群组共享: 拉群内共享的笔记 (群内置顶 DESC + sharedAt DESC 排序), 含 authorNickname/Avatar + groupPinned 给 NoteCard 用
  getGroupNotes(groupId: string, params?: { page?: number; limit?: number }) {
    const qs = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : '';
    return request<PaginatedResponse<Note>>(`/groups/${groupId}/notes${qs}`);
  },
  // 群内独立置顶 (跟 notes.pinned 作者全局置顶分离). owner/admin 才能操作
  pinGroupNote(groupId: string, noteId: string) {
    return request<{ message: string }>(`/groups/${groupId}/notes/${noteId}/pin`, { method: 'POST' });
  },
  unpinGroupNote(groupId: string, noteId: string) {
    return request<{ message: string }>(`/groups/${groupId}/notes/${noteId}/pin`, { method: 'DELETE' });
  },
  updateGroup(id: string, data: { name?: string; avatar?: string | null; autoJoin?: boolean; announcement?: string | null }) {
    return request<{ data: Group }>(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  },
  // 解散群: 仅 owner. 后端事务清 groups + group_members + group_join_requests + note_shares
  dissolveGroup(id: string) {
    return request<{ message: string }>(`/groups/${id}`, { method: 'DELETE' });
  },

  // Invite (公开邀请页 + 申请加入)
  resetInvite(groupId: string) {
    return request<{ data: { inviteToken: string; inviteExpiresAt: string } }>(`/groups/${groupId}/invite/reset`, { method: 'POST' });
  },
  closeInvite(groupId: string) {
    return request<{ message: string }>(`/groups/${groupId}/invite`, { method: 'DELETE' });
  },
  // 公开接口: 未登录也能看 (request 带 token 也无害, server 不查)
  getInvite(token: string) {
    return request<{ data: InvitePreview }>(`/invite/${token}`);
  },
  applyInvite(token: string) {
    return request<{ data: ApplyInviteResult }>(`/invite/${token}/apply`, { method: 'POST' });
  },

  // Join requests (owner/admin 审批)
  getJoinRequests(groupId: string) {
    return request<{ data: GroupJoinRequest[] }>(`/groups/${groupId}/join-requests`);
  },
  approveJoinRequest(groupId: string, requestId: string) {
    return request<{ message: string }>(`/groups/${groupId}/join-requests/${requestId}/approve`, { method: 'POST' });
  },
  rejectJoinRequest(groupId: string, requestId: string) {
    return request<{ message: string }>(`/groups/${groupId}/join-requests/${requestId}/reject`, { method: 'POST' });
  },

  // Member 管理 (踢人 / 自己退群: 同一接口, server 按 meId===targetId 区分)
  removeMember(groupId: string, userId: string) {
    return request<{ message: string }>(`/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
  },
  patchMemberRole(groupId: string, userId: string, role: 'admin' | 'member') {
    return request<{ message: string }>(`/groups/${groupId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) });
  },

  // 通知中心
  getNotifications(params?: { category?: 'content' | 'reminder' | 'group'; page?: number; limit?: number }) {
    const q = new URLSearchParams();
    if (params?.category) q.set('category', params.category);
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return request<{ data: NotificationItem[]; total: number; page: number; limit: number }>(
      `/notifications${qs ? '?' + qs : ''}`,
    );
  },
  getNotificationUnreadCount() {
    return request<{ data: { total: number; content: number; reminder: number; group: number } }>(
      '/notifications/unread-count',
    );
  },
  markNotificationRead(id: string) {
    return request<{ data: { id: string; readAt: string } }>(`/notifications/${id}/read`, { method: 'POST' });
  },
  markNotificationReadAll(category?: 'content' | 'reminder' | 'group') {
    const qs = category ? `?category=${category}` : '';
    return request<{ data: { updated: number } }>(`/notifications/read-all${qs}`, { method: 'POST' });
  },
  deleteNotification(id: string) {
    return request<{ message: string }>(`/notifications/${id}`, { method: 'DELETE' });
  },
  clearNotifications(category?: 'content' | 'reminder' | 'group') {
    const qs = category ? `?category=${category}` : '';
    return request<{ data: { deleted: number } }>(`/notifications${qs}`, { method: 'DELETE' });
  },

  // 提醒分家
  setPersonalReminder(noteId: string, body: { dueAt: string; rrule?: string | null }) {
    return request<{ data: { noteId: string; dueAt: string; rrule: string | null } }>(`/notes/${noteId}/personal-reminder`, {
      method: 'POST', body: JSON.stringify(body),
    });
  },
  deletePersonalReminder(noteId: string) {
    return request<{ message: string }>(`/notes/${noteId}/personal-reminder`, { method: 'DELETE' });
  },
  setGroupReminder(noteId: string, body: { groupId: string; dueAt: string; rrule?: string | null }) {
    return request<{ data: { noteId: string; groupId: string; dueAt: string; rrule: string | null } }>(`/notes/${noteId}/group-reminder`, {
      method: 'POST', body: JSON.stringify(body),
    });
  },
  deleteGroupReminder(noteId: string, groupId: string) {
    return request<{ message: string }>(`/notes/${noteId}/group-reminder?groupId=${encodeURIComponent(groupId)}`, { method: 'DELETE' });
  },
  getNoteReminders(noteId: string) {
    return request<{ data: { personal: PersonalReminderRow | null; group: GroupReminderRow[]; muted: boolean } }>(`/notes/${noteId}/reminders`);
  },
  // 卡片级群提醒 mute (跨所有 share 群对该笔记不接收, 仅影响调用者本人)
  muteNoteGroupReminder(noteId: string) {
    return request<{ message: string }>(`/notes/${noteId}/group-reminder/mute`, { method: 'POST' });
  },
  unmuteNoteGroupReminder(noteId: string) {
    return request<{ message: string }>(`/notes/${noteId}/group-reminder/mute`, { method: 'DELETE' });
  },
  // getGroupReminderSubscription / setGroupReminderSubscription 已移除 (开关废)
};

// 提醒分家 type
export interface PersonalReminderRow {
  id: string;
  userId: string;
  noteId: string;
  dueAt: string;
  rrule: string | null;
  remindSentAt: string | null;
  createdAt: string;
}
export interface GroupReminderRow {
  id: string;
  noteId: string;
  groupId: string;
  dueAt: string;
  rrule: string | null;
  remindSentAt: string | null;
  createdBy: string;
  createdAt: string;
}

// 通知中心 type
// userId optional: list/unread 接口返回带 userId; SSE notification-new payload 不带 (推给收件人本身, 不需要重复字段),
// 让两种来源都能 typecheck. 前端用不到 userId 字段 (只渲染本人通知)
export interface NotificationItem {
  id: string;
  userId?: string;
  category: 'content' | 'reminder' | 'group';
  type: string;
  title: string;
  body: string | null;
  payload: Record<string, any> | null;
  readAt: string | null;
  createdAt: string;
}

// SSE token helper - utils/sse.ts 用; 跟 request() 内部 getToken 共用同一个 localStorage key
export function getAuthToken(): string | null {
  return localStorage.getItem('quink_token');
}
