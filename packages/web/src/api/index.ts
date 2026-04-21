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

  async uploadFile(file: File, endpoint: 'avatar' | 'file' = 'file'): Promise<{ data: { url: string; filename?: string; type?: string; category?: string; size?: number } }> {
    const formData = new FormData();
    formData.append('file', file);

    const token = getToken();
    const res = await fetch(`${BASE}/upload/${endpoint}`, {
      method: 'POST',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  // Files
  getFiles() {
    return request<{ data: Array<{ id: string; filename: string; url: string; mimeType: string; category: string; size: number; createdAt: string }> }>('/upload/files');
  },

  deleteFile(id: string) {
    return request<{ message: string }>(`/upload/files/${id}`, { method: 'DELETE' });
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
    formData.append('file', audioBlob, 'audio.webm');
    const token = getToken();
    const res = await fetch('/api/ai/transcribe', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!res.ok) throw new Error((await res.json()).error || '语音识别失败');
    return res.json();
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

  // Stats
  getStats() {
    return request<{ data: { totalNotes: number; totalTodos: number; pendingTodos: number } }>('/stats');
  },
};
