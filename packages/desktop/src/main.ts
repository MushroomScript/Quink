import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  screen,
  ipcMain,
  shell,
  globalShortcut,
  clipboard,
} from 'electron';
import * as path from 'path';
import { createTrayIcon } from './tray-icon';
import { registerShortcut, unregisterAll, startHook, stopHook } from './shortcuts';

const API_BASE = `http://localhost:${process.env.QUINK_PORT || '38999'}`;
const WEB_URL = `http://localhost:${process.env.QUINK_WEB_PORT || '24888'}`;

let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let floatWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let authToken: string | null = null;
let aiChatWindow: BrowserWindow | null = null;

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
  const ok2 = registerShortcut(currentShortcuts.aiChat, () => toggleAiChatWindow());

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
      click: () => toggleAiChatWindow(),
    },
    {
      label: '抓取选中文字  Ctrl+Shift+E',
      click: () => grabAndShowFloat(),
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

ipcMain.on('hide-window', (_event) => {
  // 找到发送消息的窗口并隐藏
  const win = BrowserWindow.fromWebContents(_event.sender);
  if (win) win.hide();
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

  // 全局选中悬浮窗：快捷键触发
  tryInitSelectionGrabber();

  console.log('Quink Desktop is running.');
});

app.on('will-quit', () => {
  stopHook();
  tryStopSelectionMonitor();
});

// ──────────────────────────────────
//  AI 对话快捷窗口
// ──────────────────────────────────
function createAiChatWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  aiChatWindow = new BrowserWindow({
    width: 480,
    height: 560,
    x: Math.round(screenWidth / 2 - 240),
    y: Math.round(screenHeight * 0.15),
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: false,
    backgroundColor: '#ffffff',
    roundedCorners: true,
    minWidth: 400,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  aiChatWindow.loadURL(`${WEB_URL}/ai-chat`);

  let blurEnabled = false;
  aiChatWindow.on('show', () => {
    blurEnabled = false;
    setTimeout(() => { blurEnabled = true; }, 300);
  });
  aiChatWindow.on('blur', () => {
    if (blurEnabled) hideAiChatWindow();
  });

  aiChatWindow.on('closed', () => { aiChatWindow = null; });
}

function toggleAiChatWindow() {
  if (!aiChatWindow) {
    createAiChatWindow();
    aiChatWindow!.once('ready-to-show', () => {
      aiChatWindow!.show();
      aiChatWindow!.focus();
    });
    return;
  }
  if (aiChatWindow.isVisible()) {
    hideAiChatWindow();
  } else {
    aiChatWindow.show();
    aiChatWindow.focus();
  }
}

function hideAiChatWindow() {
  if (aiChatWindow && aiChatWindow.isVisible()) {
    aiChatWindow.hide();
  }
}

app.on('window-all-closed', () => {
  // Do nothing — stay in tray
});

// ──────────────────────────────────
//  全局悬浮窗（选中文字后弹出）
// ──────────────────────────────────

function showFloatWindow(text: string, x: number, y: number) {
  if (!authToken) return;

  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.close();
  }

  // 多显示器：找到鼠标所在的显示器
  const cursorDisplay = screen.getDisplayNearestPoint({ x, y });
  const bounds = cursorDisplay.workArea;
  const winW = 180;
  const winH = 44;
  const px = Math.max(bounds.x, Math.min(x + 10, bounds.x + bounds.width - winW - 10));
  const py = Math.max(bounds.y, Math.min(y + 10, bounds.y + bounds.height - winH - 10));

  floatWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: px,
    y: py,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: false,
    backgroundColor: '#ffffff',
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const encodedText = encodeURIComponent(text.slice(0, 2000));
  floatWindow.loadURL(`${WEB_URL}/float?text=${encodedText}`);

  floatWindow.once('ready-to-show', () => {
    floatWindow?.show();
  });

  // 失焦自动关闭
  floatWindow.on('blur', () => {
    setTimeout(() => {
      if (floatWindow && !floatWindow.isDestroyed()) {
        floatWindow.close();
        floatWindow = null;
      }
    }, 200);
  });

  floatWindow.on('closed', () => {
    floatWindow = null;
  });
}

function tryInitSelectionGrabber() {
  // 用 Electron globalShortcut（不用 uiohook，三键组合更可靠）
  const ok = globalShortcut.register('CommandOrControl+Shift+E', () => {
    grabAndShowFloat();
  });
  console.log(`Selection grabber: Ctrl+Shift+E(${ok}).`);
}

function grabAndShowFloat() {
  const text = clipboard.readText();
  if (text && text.trim()) {
    const pos = screen.getCursorScreenPoint();
    showFloatWindow(text.trim(), pos.x, pos.y);
  }
}

function tryStopSelectionMonitor() {}
