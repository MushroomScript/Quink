import { contextBridge, ipcRenderer } from 'electron';

// attachmentTasks 挂在 quink 命名空间下 (Capture/AiChat 窗口的 preload). 不暴露 quinkDesktop —— 否则 auth.ts
// 的 syncTokenToDesktop(window.quinkDesktop?.syncToken(t)) 会因为 quinkDesktop truthy 但 syncToken=undefined 抛 TypeError,
// 进 fetchMe catch 把 user 重置 null, 快捷窗口显示"请先在主窗口登录" (实际上 token + 后端都 OK).
// useAttachmentTasks 已经 fallback 到 quink.attachmentTasks
contextBridge.exposeInMainWorld('quink', {
  saveNote: (content: string, type: string) => ipcRenderer.invoke('save-note', content, type),
  hideWindow: () => ipcRenderer.send('hide-window'),
  noteSaved: (noteId?: string) => ipcRenderer.send('note-saved', noteId),
  // Vditor 等异步组件加载完后调用，让主进程延迟到此刻才 show 窗口，避免布局跳变
  notifyContentReady: () => ipcRenderer.send('content-ready'),
  onWindowShown: (callback: () => void) => {
    ipcRenderer.on('window-shown', () => callback());
  },
  onWindowHidden: (callback: () => void) => {
    ipcRenderer.on('window-hidden', () => callback());
  },
  attachmentTasks: {
    get: () => ipcRenderer.invoke('attachment-tasks:get'),
    add: (task: any) => ipcRenderer.invoke('attachment-tasks:add', task),
    updateProgress: (id: string, received: number, total: number) =>
      ipcRenderer.send('attachment-tasks:update-progress', { id, received, total }),
    markSuccess: (id: string) => ipcRenderer.send('attachment-tasks:mark-success', id),
    markFailed: (id: string, error: string) =>
      ipcRenderer.send('attachment-tasks:mark-failed', { id, error }),
    remove: (id: string) => ipcRenderer.send('attachment-tasks:remove', id),
    cancel: (id: string) => ipcRenderer.send('attachment-tasks:cancel', id),
    clearCompleted: () => ipcRenderer.send('attachment-tasks:clear-completed'),
    close: () => ipcRenderer.send('attachment-tasks:close'),
    onSync: (cb: (tasks: any[]) => void) => {
      ipcRenderer.removeAllListeners('attachment-tasks:sync');
      ipcRenderer.on('attachment-tasks:sync', (_e, tasks) => cb(tasks));
    },
    onProgress: (cb: (p: { id: string; received: number; total: number }) => void) => {
      ipcRenderer.removeAllListeners('attachment-tasks:progress');
      ipcRenderer.on('attachment-tasks:progress', (_e, p) => cb(p));
    },
    onAbortUploads: (cb: (ids: string[]) => void) => {
      ipcRenderer.removeAllListeners('attachment-tasks:abort-uploads');
      ipcRenderer.on('attachment-tasks:abort-uploads', (_e, ids) => cb(ids));
    },
  },
});
