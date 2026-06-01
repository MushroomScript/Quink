import { contextBridge, ipcRenderer } from 'electron';

// 主窗口 preload — 用于同步 token 和快捷键
contextBridge.exposeInMainWorld('quinkDesktop', {
  syncToken: (token: string | null) => ipcRenderer.send('sync-token', token),
  reloadShortcuts: () => ipcRenderer.send('reload-shortcuts'),
  syncTheme: (theme: string) => ipcRenderer.send('sync-theme', theme),
  syncZoom: (level: number) => ipcRenderer.send('sync-zoom', level),
  // 下载目录: renderer 启动时把 localStorage 中的下载路径推给 main, will-download 用它
  syncDownloadPath: (dir: string) => ipcRenderer.send('sync-download-path', dir),
  // 设置页选目录: 弹系统目录选择对话框, 返回路径或 null
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('pick-directory'),
  // 拿系统默认下载目录 (Windows: C:\Users\xxx\Downloads, macOS: /Users/xxx/Downloads)
  getDefaultDownloadDir: (): Promise<string> => ipcRenderer.invoke('get-default-download-dir'),
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  // 用系统默认应用打开附件 URL(fetch 到临时目录 → shell.openPath)
  openAttachment: (url: string) => ipcRenderer.invoke('open-attachment', url),
  // 用户主动取消正在下载的附件
  cancelAttachment: (url: string) => ipcRenderer.invoke('cancel-attachment', url),
  // PDF 首页缩略图持久化缓存. 返回 Buffer 或 null; put 写盘. 渲染进程拿到 Buffer 后包成 Blob → ObjectURL
  // (HEIC 不再需要客户端缓存 IPC, 后端已生成 .thumb.jpg 直接 GET)
  pdfThumbCacheGet: (url: string): Promise<Uint8Array | null> => ipcRenderer.invoke('pdf-thumb-cache:get', url),
  pdfThumbCachePut: (url: string, data: ArrayBuffer): Promise<boolean> => ipcRenderer.invoke('pdf-thumb-cache:put', url, data),
  // 视频首帧持久化缓存. 同 PDF pattern. 缓存命中后 list/grid 用 <img> 不再挂 <video> 媒体 pipeline
  videoThumbCacheGet: (url: string): Promise<Uint8Array | null> => ipcRenderer.invoke('video-thumb-cache:get', url),
  videoThumbCachePut: (url: string, data: ArrayBuffer): Promise<boolean> => ipcRenderer.invoke('video-thumb-cache:put', url, data),
  // 订阅附件下载进度: main 流式 fetch 时每 100ms 推一次 { url, received, total }
  // removeAllListeners 防止 HMR 重 mount 时累积 listener
  onAttachmentProgress: (cb: (data: { url: string; received: number; total: number }) => void) => {
    ipcRenderer.removeAllListeners('attachment-progress');
    ipcRenderer.on('attachment-progress', (_e, data) => cb(data));
  },
  // 全局附件传输任务 (跨窗口共享 + 跨 session 持久化). 状态唯一来源在 main, 这里都是薄封装.
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
    // main → renderer 事件 (full sync / 单条 progress / abort uploads 请求)
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
  // 待办提醒: SSE 推到 renderer 后转给 main 弹 OS 原生通知 (任务栏闪 + 通知中心收纳)
  showNotification: (payload: { title: string; body: string; noteId?: string }) =>
    ipcRenderer.send('show-notification', payload),
  // main → renderer: 用户点击通知 → 跳详情页. App.vue 监听
  onOpenNote: (cb: (noteId: string) => void) => {
    ipcRenderer.removeAllListeners('open-note');
    ipcRenderer.on('open-note', (_e, noteId: string) => cb(noteId));
  },
  isElectron: true,
});
