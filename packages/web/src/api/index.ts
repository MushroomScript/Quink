const BASE = '/api';

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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
  let res: Response;
  try {
    res = await fetch(`${BASE}${url}`, { headers, ...options, signal: controller.signal });
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
  content: string;
  summary: string | null;
  category: string | null;
  tags: string[];
  type: 'note' | 'todo' | 'snippet' | 'link';
  todoStatus: 'pending' | 'done' | null;
  todoDue: string | null;
  aiProcessed: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number };
}

export interface Category {
  id: number;
  name: string;
  parentId: number | null;
  icon: string | null;
  sortOrder: number;
  children: Category[];
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

  createNote(data: { content: string; type?: string; category?: string; tags?: string[] }) {
    return request<{ data: Note }>('/notes', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  updateNote(id: string, data: Partial<Note>) {
    return request<{ data: Note }>(`/notes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  deleteNote(id: string) {
    return request<{ message: string }>(`/notes/${id}`, { method: 'DELETE' });
  },

  // Categories
  getCategories() {
    return request<{ data: Category[] }>('/categories');
  },

  createCategory(data: { name: string; parentId?: number | null }) {
    return request<{ data: Category }>('/categories', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  deleteCategory(id: number) {
    return request<{ message: string }>(`/categories/${id}`, { method: 'DELETE' });
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
      xhr.open('POST', `${BASE}/upload/${endpoint}`);
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
    const res = await fetch(`${BASE}/upload/folders/${folder.id}/download`, {
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
    const res = await fetch('/api/ai/transcribe', {
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
  async exportData(): Promise<void> {
    const token = getToken();
    const res = await fetch(`${BASE}/data`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error('导出失败');
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
    const res = await fetch(`${BASE}/data`, {
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
};
