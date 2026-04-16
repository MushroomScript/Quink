import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  screen,
  ipcMain,
  shell,
} from 'electron';
import * as path from 'path';
import { createTrayIcon } from './tray-icon';
import { registerShortcut, unregisterAll, startHook, stopHook } from './shortcuts';

const API_BASE = `http://localhost:${process.env.QUINK_PORT || '38999'}`;
const WEB_URL = `http://localhost:${process.env.QUINK_WEB_PORT || '24888'}`;

let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let authToken: string | null = null;

// 默认快捷键
const DEFAULT_SHORTCUTS = {
  capture: 'Shift+Space',
  aiChat: 'Alt+Space',
};

let currentShortcuts = { ...DEFAULT_SHORTCUTS };

// ──────────────────────────────────
//  从后端获取用户快捷键配置
// ──────────────────────────────────
async function loadUserShortcuts() {
  if (!authToken) return;
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const prefs = data.data?.preferences;
    if (prefs?.shortcuts) {
      currentShortcuts = { ...DEFAULT_SHORTCUTS, ...prefs.shortcuts };
    }
  } catch {}
}

function applyShortcuts() {
  unregisterAll();

  const ok1 = registerShortcut(currentShortcuts.capture, () => toggleCaptureWindow());
  const ok2 = registerShortcut(currentShortcuts.aiChat, () => showMainWindow());

  console.log(`Shortcuts registered: capture=${currentShortcuts.capture}(${ok1}), aiChat=${currentShortcuts.aiChat}(${ok2})`);
}

// ──────────────────────────────────
//  主窗口（浏览/管理笔记）
// ──────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1166,
    minHeight: 860,
    title: 'Quink - 一念',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-main.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 彻底删掉菜单栏（Alt 键也不会弹出）
  Menu.setApplicationMenu(null);
  mainWindow.loadURL(WEB_URL);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow!.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow!.show();
  });
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ──────────────────────────────────
//  快捷输入窗口
// ──────────────────────────────────
function createCaptureWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  captureWindow = new BrowserWindow({
    width: 650,
    height: 350,
    minWidth: 650,
    minHeight: 350,
    x: Math.round(screenWidth / 2 - 325),
    y: Math.round(screenHeight * 0.2),
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: false,
    backgroundColor: '#00000000',
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 加载 Web 端的快捷输入页面
  captureWindow.loadURL(`${WEB_URL}/capture`);

  // 延迟绑定 blur，避免刚 show 就被 hide
  let blurEnabled = false;
  captureWindow.on('show', () => {
    blurEnabled = false;
    setTimeout(() => { blurEnabled = true; }, 300);
  });
  captureWindow.on('blur', () => {
    if (blurEnabled) hideCaptureWindow();
  });

  captureWindow.on('closed', () => {
    captureWindow = null;
  });
}

function toggleCaptureWindow() {
  if (!captureWindow) {
    createCaptureWindow();
    captureWindow!.once('ready-to-show', () => {
      captureWindow!.show();
      captureWindow!.focus();
    });
    return;
  }

  if (captureWindow.isVisible()) {
    hideCaptureWindow();
  } else {
    captureWindow.show();
    captureWindow.focus();
    captureWindow.webContents.send('window-shown');
  }
}

function hideCaptureWindow() {
  if (captureWindow && captureWindow.isVisible()) {
    captureWindow.hide();
    captureWindow.webContents.send('window-hidden');
  }
}

// ──────────────────────────────────
//  系统托盘
// ──────────────────────────────────
function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Quink - 一念');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开 Quink',
      click: () => showMainWindow(),
    },
    {
      label: `快速记录  ${currentShortcuts.capture}`,
      click: () => toggleCaptureWindow(),
    },
    {
      label: `AI 对话  ${currentShortcuts.aiChat}`,
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => showMainWindow());
}

// ──────────────────────────────────
//  IPC
// ──────────────────────────────────
ipcMain.handle('save-note', async (_event, content: string, type: string) => {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const res = await fetch(`${API_BASE}/api/notes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content, type }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hideCaptureWindow();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('quink-note-created'))`
      ).catch(() => {});
    }

    return { success: true, data: data.data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('hide-window', () => {
  hideCaptureWindow();
});

ipcMain.on('sync-token', (_event, token: string | null) => {
  authToken = token;
  if (token) {
    loadUserShortcuts().then(() => applyShortcuts());
  }
});

ipcMain.on('reload-shortcuts', () => {
  loadUserShortcuts().then(() => {
    applyShortcuts();
    // 重建托盘菜单以更新快捷键标签
    if (tray) createTray();
  });
});

// ──────────────────────────────────
//  启动
// ──────────────────────────────────
app.whenReady().then(() => {
  createMainWindow();
  createCaptureWindow();
  createTray();

  // 启动底层键盘钩子并注册默认快捷键
  startHook();
  applyShortcuts();

  console.log('Quink Desktop is running.');
});

app.on('will-quit', () => {
  stopHook();
});

app.on('window-all-closed', () => {
  // Do nothing — stay in tray
});
