import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('quink', {
  saveNote: (content: string, type: string) => ipcRenderer.invoke('save-note', content, type),
  hideWindow: () => ipcRenderer.send('hide-window'),
  onWindowShown: (callback: () => void) => {
    ipcRenderer.on('window-shown', () => callback());
  },
  onWindowHidden: (callback: () => void) => {
    ipcRenderer.on('window-hidden', () => callback());
  },
});
