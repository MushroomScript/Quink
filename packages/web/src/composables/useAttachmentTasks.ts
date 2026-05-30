import { ref } from 'vue';

// 传输任务全局状态. 跨窗口共享 (Electron 下走 main 端 attachmentTasksStore IPC 中心化, 主 / Capture / AiChat 同步;
// 浏览器场景没多窗口, fallback 到本地 ref + localStorage 持久化).
// 用法:
//   下载: App.vue 点击附件链接时 addDownloadTask → main 端 open-attachment IPC 自己调 store.updateProgress/markSuccess
//         → store broadcast 给所有窗口 → 本地 ref 跟 sync 事件更新
//   上传: Resources / 编辑器 上传文件时 addUploadTask → XHR onprogress 推 updateProgressById
//         → 上传 result 调 markSuccessById / markFailedById / markCancelledById
//   dock 组件读 tasks/dockVisible 渲染, 用户可清空已完成 / 单条 dismiss / 取消进行中 / 点击 success download 再次打开

export type TaskKind = 'download' | 'upload';
export type AttachmentStatus = 'downloading' | 'success' | 'failed' | 'cancelled';

export interface AttachmentTask {
  id: string;
  kind: TaskKind;
  url: string;          // download: fullUrl; upload: 用作唯一键(可填 file://filename + timestamp)
  filename: string;
  received: number;
  total: number;
  status: AttachmentStatus;
  error?: string;
  // upload 任务的 abort controller, 取消时调 abort(). main 端 attachmentTasksStore 不存它 (跨进程无法序列化),
  // 仅本地 ref 维护. download 走 main 端的 cancel-attachment IPC, 不用这个
  abortController?: AbortController;
}

export const tasks = ref<AttachmentTask[]>([]);
export const dockVisible = ref(false);

function genId(): string {
  return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Electron 端: main 进程的 attachmentTasks API (跨窗口 IPC). 主窗口走 quinkDesktop.attachmentTasks,
// Capture/AiChat 快捷窗口走 quink.attachmentTasks (那俩窗口的 preload 不暴露 quinkDesktop 避免破坏 auth.ts 的 syncTokenToDesktop).
// 浏览器场景下两者都 undefined → 走 localStorage fallback
const ipc = ((window as any).quinkDesktop?.attachmentTasks
  ?? (window as any).quink?.attachmentTasks) as {
  get: () => Promise<AttachmentTask[]>;
  add: (task: AttachmentTask) => Promise<string>;
  updateProgress: (id: string, received: number, total: number) => void;
  markSuccess: (id: string) => void;
  markFailed: (id: string, error: string) => void;
  remove: (id: string) => void;
  cancel: (id: string) => void;
  clearCompleted: () => void;
  close: () => void;
  onSync: (cb: (tasks: AttachmentTask[]) => void) => void;
  onProgress: (cb: (p: { id: string; received: number; total: number }) => void) => void;
  onAbortUploads: (cb: (ids: string[]) => void) => void;
} | undefined;

// 本地 upload AbortController Map (本窗口发起的 upload 才有 controller, 跨进程不能传).
// cancelTask + onAbortUploads 事件用这个 abort 本地 xhr/fetch
const localAbortControllers = new Map<string, AbortController>();

// 序列化跨 IPC 时不要带 abortController (DataCloneError); 这个 helper 把任务"净化"成可序列化的形态
function sanitize(t: AttachmentTask): AttachmentTask {
  const { abortController, ...rest } = t;
  return rest;
}

// ===== 浏览器 fallback: 本地 localStorage (Electron 不走这条) =====
const FALLBACK_KEY = 'quink_attachment_tasks';
const MAX_HISTORY = 50;

function fallbackPersist(): void {
  try {
    const finalized = tasks.value
      .filter((t) => t.status !== 'downloading')
      .slice(-MAX_HISTORY)
      .map(sanitize);
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(finalized));
  } catch {}
}

function fallbackLoad(): void {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    tasks.value = arr.filter((x: any) =>
      x && typeof x.id === 'string' &&
      (x.kind === 'download' || x.kind === 'upload') &&
      typeof x.url === 'string' && typeof x.filename === 'string' &&
      x.status !== 'downloading'
    );
  } catch {}
}

// ===== 启动初始化 =====
if (ipc) {
  // Electron: 拉初始全量 + 订阅 sync / progress / abort-uploads 事件
  ipc.get().then((initial) => {
    tasks.value = initial.map((t) => ({ ...t }));
  }).catch(() => {});
  ipc.onSync((next) => {
    // 全量替换. 保留本地 abortController (sync 来的对象没这个字段, 本地的 upload controller 需要保留)
    tasks.value = next.map((t) => {
      const ctrl = localAbortControllers.get(t.id);
      return ctrl ? { ...t, abortController: ctrl } : { ...t };
    });
  });
  ipc.onProgress(({ id, received, total }) => {
    // 单条进度更新, 直接 mutate ref 里那一条
    const t = tasks.value.find((x) => x.id === id);
    if (!t) return;
    t.received = received;
    t.total = total;
  });
  ipc.onAbortUploads((ids) => {
    // main 收到 cancel/close 请求时广播给所有窗口, 本地有 controller 的就 abort
    for (const id of ids) {
      const ctrl = localAbortControllers.get(id);
      if (ctrl) {
        try { ctrl.abort(); } catch {}
        localAbortControllers.delete(id);
      }
    }
  });
} else {
  // 浏览器: 走本地 ref + localStorage
  fallbackLoad();
}

// ===== Download 任务 =====

// Electron: await IPC add 确保 main 端 task 状态就绪, 调用方再触发 open-attachment 才不会 race
// (两个 IPC 不同 channel 无顺序保证, mark-success 可能比 add 先到 store 找不到 task).
// 不在本地乐观推 task, 等 sync 推回, 避免本地 id 跟 main reuse 后的 id mismatch.
// Web 端 (无 IPC) 同步操作本地 ref + localStorage
export async function addDownloadTask(url: string, filename: string): Promise<void> {
  if (!ipc) {
    const existing = tasks.value.find((t) => t.kind === 'download' && t.url === url);
    if (existing) {
      if (existing.status !== 'downloading') {
        existing.status = 'downloading';
        existing.received = 0;
        existing.error = undefined;
      }
      dockVisible.value = true;
      fallbackPersist();
      return;
    }
    const id = genId();
    tasks.value.push({ id, kind: 'download', url, filename, received: 0, total: 0, status: 'downloading' });
    dockVisible.value = true;
    fallbackPersist();
    return;
  }
  dockVisible.value = true;
  try {
    await ipc.add({ id: genId(), kind: 'download', url, filename, received: 0, total: 0, status: 'downloading' });
    // main 端 add + broadcast sync 已发出, 本地 ref 通过 sync 监听更新
  } catch {}
}

// 保留旧函数名兼容 App.vue 现有调用
export const addTask = addDownloadTask;

// ===== Upload 任务 =====

// 返回真实 id (main 端 upload 不 reuse, 跟传入一致). 调用方 await 拿 id 后再调 updateProgressById 才能保证时序
export async function addUploadTask(filename: string, total: number, abortController?: AbortController): Promise<string> {
  const url = `file://${filename}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const id = genId();
  const task: AttachmentTask = { id, kind: 'upload', url, filename, received: 0, total, status: 'downloading', abortController };
  dockVisible.value = true;
  if (abortController) localAbortControllers.set(id, abortController);
  if (!ipc) {
    tasks.value.push(task);
    fallbackPersist();
    return id;
  }
  try {
    const actualId = await ipc.add(sanitize(task));
    // upload main 端不 reuse, actualId 应该等于传入 id; 但兜底用 main 返回的实际 id
    if (actualId !== id) {
      // 极端情况 (理论上不应发生): main 返回不同 id, 本地 controller map 用 actualId 重新绑定
      const ctrl = localAbortControllers.get(id);
      if (ctrl) {
        localAbortControllers.delete(id);
        localAbortControllers.set(actualId, ctrl);
      }
      return actualId;
    }
  } catch {}
  return id;
}

// ===== 通用更新 =====

export function updateProgress(url: string, received: number, total: number): void {
  const t = tasks.value.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  t.received = received;
  t.total = total;
  if (ipc) ipc.updateProgress(t.id, received, total);
  // fallback 不持久化 downloading 状态, 无需 fallbackPersist
}

export function updateProgressById(id: string, received: number, total: number): void {
  const t = tasks.value.find((x) => x.id === id && x.status === 'downloading');
  if (!t) return;
  t.received = received;
  t.total = total;
  if (ipc) ipc.updateProgress(id, received, total);
}

export function markSuccess(url: string): void {
  const t = tasks.value.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  t.status = 'success';
  if (t.total === 0) t.total = 1;
  t.received = t.total;
  localAbortControllers.delete(t.id);
  if (ipc) ipc.markSuccess(t.id); else fallbackPersist();
}

export function markSuccessById(id: string): void {
  const t = tasks.value.find((x) => x.id === id && x.status === 'downloading');
  if (!t) return;
  t.status = 'success';
  if (t.total === 0) t.total = 1;
  t.received = t.total;
  localAbortControllers.delete(id);
  if (ipc) ipc.markSuccess(id); else fallbackPersist();
}

export function markFailed(url: string, error: string): void {
  const t = tasks.value.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  t.status = 'failed';
  t.error = error;
  localAbortControllers.delete(t.id);
  if (ipc) ipc.markFailed(t.id, error); else fallbackPersist();
}

export function markFailedById(id: string, error: string): void {
  const t = tasks.value.find((x) => x.id === id && x.status === 'downloading');
  if (!t) return;
  t.status = 'failed';
  t.error = error;
  localAbortControllers.delete(id);
  if (ipc) ipc.markFailed(id, error); else fallbackPersist();
}

export function markCancelled(url: string): void {
  const t = tasks.value.find((x) => x.url === url && x.status === 'downloading');
  if (!t) return;
  const idx = tasks.value.indexOf(t);
  tasks.value.splice(idx, 1);
  localAbortControllers.delete(t.id);
  if (ipc) ipc.remove(t.id); else fallbackPersist();
}

export function markCancelledById(id: string): void {
  const idx = tasks.value.findIndex((x) => x.id === id && x.status === 'downloading');
  if (idx < 0) return;
  tasks.value.splice(idx, 1);
  localAbortControllers.delete(id);
  if (ipc) ipc.remove(id); else fallbackPersist();
}

// ===== 用户操作 =====

// 取消传输. Electron: download 走 main 端 cancel-attachment IPC (现成的), upload 走本地 abort + IPC remove.
// 浏览器: 同样逻辑但都本地处理
export async function cancelTask(id: string): Promise<void> {
  const t = tasks.value.find((x) => x.id === id && x.status === 'downloading');
  if (!t) return;
  if (t.kind === 'download') {
    const desk = (window as any).quinkDesktop;
    try { await desk?.cancelAttachment?.(t.url); } catch {}
    // main 端 fetch abort 后 catch 分支调 store.removeByUrl, sync 会自动推过来
  } else {
    // upload: abort 本地 controller; 通知 main 端从列表移除 (main 端没 controller 但要 broadcast 让其他窗口同步)
    const ctrl = localAbortControllers.get(id) || t.abortController;
    try { ctrl?.abort(); } catch {}
    localAbortControllers.delete(id);
    markCancelledById(id);
  }
}

// 手动 dismiss 已完成 (success/failed) 任务. downloading 状态不允许 dismiss (要先 cancel)
export function dismissTask(id: string): void {
  const idx = tasks.value.findIndex((x) => x.id === id && x.status !== 'downloading');
  if (idx < 0) return;
  tasks.value.splice(idx, 1);
  if (tasks.value.length === 0) dockVisible.value = false;
  if (ipc) ipc.remove(id); else fallbackPersist();
}

// 清空所有已完成 (success/failed/cancelled). 进行中的不动
export function clearCompleted(): void {
  tasks.value = tasks.value.filter((t) => t.status === 'downloading');
  if (tasks.value.length === 0) dockVisible.value = false;
  if (ipc) ipc.clearCompleted(); else fallbackPersist();
}

// 手动关闭整个 dock (清空全部, 含进行中). Electron 端 main 会 broadcast abort-uploads 让本地 controller abort
export function closeDock(): void {
  // 本地立即 abort 所有 upload controller (sync 来覆盖前用户感知到的响应)
  for (const t of tasks.value) {
    if (t.status === 'downloading' && t.kind === 'upload') {
      const ctrl = localAbortControllers.get(t.id) || t.abortController;
      try { ctrl?.abort(); } catch {}
    }
  }
  localAbortControllers.clear();
  tasks.value = [];
  dockVisible.value = false;
  if (ipc) ipc.close(); else fallbackPersist();
}
