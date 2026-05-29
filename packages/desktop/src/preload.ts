import { contextBridge, ipcRenderer } from 'electron';

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
});
