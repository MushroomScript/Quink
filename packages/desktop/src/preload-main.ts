import { contextBridge, ipcRenderer } from 'electron';

// 主窗口 preload — 用于同步 token 和快捷键
contextBridge.exposeInMainWorld('quinkDesktop', {
  syncToken: (token: string | null) => ipcRenderer.send('sync-token', token),
  reloadShortcuts: () => ipcRenderer.send('reload-shortcuts'),
  syncTheme: (theme: string) => ipcRenderer.send('sync-theme', theme),
  syncFontSize: (size: number) => ipcRenderer.send('sync-font-size', size),
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
  isElectron: true,
});
