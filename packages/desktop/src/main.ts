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
import { registerShortcut, unregisterAll, startHook, stopHook, onKeydown } from './shortcuts';

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
  float: 'Alt+Q',
};

let currentShortcuts = { ...DEFAULT_SHORTCUTS };
let nativeModuleRef: any = null;
let currentTheme = 'blueberry';

// 每个主题的 accent-dark RGB(跟 style.css 一致),用于 toast 背景
const THEME_ACCENT_DARK: Record<string, string> = {
  blueberry: 'rgb(88,112,230)',
  lavender: 'rgb(139,107,228)',
  mint: 'rgb(62,178,144)',
  peach: 'rgb(235,120,100)',
  lemon: 'rgb(215,160,50)',
  cloud: 'rgb(105,125,155)',
  dark: 'rgb(100,130,230)',
};

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
    if (prefs?.theme && typeof prefs.theme === 'string') {
      currentTheme = prefs.theme;
    }
  } catch {}
}

// 统一的浮窗触发:优先 UIA(无感、瞬时、不碰剪贴板),失败再 Ctrl+C 兜底
async function triggerFloatWindow() {
  // 1) UIA 优先:浏览器 / UWP / Office / 大部分现代应用支持
  if (nativeModuleRef?.readSelectionUia) {
    try {
      const sel = await nativeModuleRef.readSelectionUia();
      if (sel && sel.text && sel.text.trim().length >= 1) {
        if (!isOwnWindow(sel.hwnd)) {
          showFloatWindow(sel.text.trim(), sel.x, sel.y);
          return;
        }
      }
    } catch (e) {
      console.log('[Float] UIA read failed:', e);
    }
  }
  // 2) Ctrl+C fallback:Notepad / 老 Win32 / Qt 等
  if (nativeModuleRef?.grabSelection) {
    nativeModuleRef.grabSelection();
  } else {
    grabAndShowFloat();
  }
}

// 判断 hwnd 是否是 Quink 自己的任一窗口
function isOwnWindow(hwnd: number | bigint): boolean {
  if (!hwnd) return false;
  const target = BigInt(hwnd);
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      const buf = w.getNativeWindowHandle();
      // Windows 下是 8 字节 HWND(小端)
      const h = buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf.readInt32LE(0));
      if (h === target) return true;
    } catch {}
  }
  return false;
}

function toggleUiaAuto() {
  // 划词识别已移除
}

// ──────────────────────────────────
//  自定义 Toast 窗口(避开 Windows 系统通知排队)
// ──────────────────────────────────
let toastWin: BrowserWindow | null = null;
let toastTimer: NodeJS.Timeout | null = null;

function showToastAt(msg: string, tx: number, ty: number) {
  _showToast(msg, tx, ty);
}

function showToast(msg: string) {
  const bounds = screen.getPrimaryDisplay().workArea;
  const w = 240, h = 44;
  const x = bounds.x + bounds.width - w - 16;
  const y = bounds.y + bounds.height - h - 16;
  _showToast(msg, x, y);
}

function _showToast(msg: string, x: number, y: number) {
  const w = 140, h = 50;

  const bg = THEME_ACCENT_DARK[currentTheme] || THEME_ACCENT_DARK.blueberry;
  const html = `<!DOCTYPE html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;font-family:system-ui,sans-serif;height:100%;}
    .toast{height:100%;display:flex;align-items:center;justify-content:center;
      background:${bg};color:#fff;font-size:15px;font-weight:600;border-radius:10px;
      box-shadow:0 4px 16px rgba(0,0,0,0.25)}
  </style></head><body><div class="toast">${msg}</div></body></html>`;

  if (toastWin && !toastWin.isDestroyed()) {
    toastWin.close();
    toastWin = null;
  }

  toastWin = new BrowserWindow({
    width: w, height: h, x, y,
    frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false,
    show: false,
    transparent: true, roundedCorners: false, hasShadow: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  toastWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  toastWin.once('ready-to-show', () => toastWin?.showInactive());
  toastWin.on('closed', () => { toastWin = null; });

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastWin && !toastWin.isDestroyed()) toastWin.close();
    toastWin = null;
    toastTimer = null;
  }, 1400);
}

function applyShortcuts() {
  unregisterAll();

  const ok1 = registerShortcut(currentShortcuts.capture, () => toggleCaptureWindow());
  const ok2 = registerShortcut(currentShortcuts.aiChat, () => toggleAiChatWindow());
  const ok3 = registerShortcut(currentShortcuts.float, () => triggerFloatWindow());

  console.log(`Shortcuts: capture=${currentShortcuts.capture}(${ok1}), aiChat=${currentShortcuts.aiChat}(${ok2}), float=${currentShortcuts.float}(${ok3})`);
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
    frame: false,
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

  // 右键上下文菜单(仅编辑区和内容显示区)
  mainWindow.webContents.on('context-menu', (_event, params) => {
    // 只在编辑区(.vditor)或内容区(.note-content/.prose)内显示
    mainWindow!.webContents.executeJavaScript(`
      (function() {
        var el = document.elementFromPoint(${params.x}, ${params.y});
        return !!(el && (el.closest('.vditor') || el.closest('.note-content') || el.closest('.prose')));
      })()
    `).then((inContentArea: boolean) => {
      if (!inContentArea) return;

      const hasSelection = params.selectionText.length > 0;

      if (params.isEditable) {
        Menu.buildFromTemplate([
          { label: '剪切', role: 'cut', enabled: hasSelection },
          { label: '复制', role: 'copy', enabled: hasSelection },
          { label: '粘贴', role: 'paste' },
          { type: 'separator' },
          { label: '全选', role: 'selectAll' },
        ]).popup();
      } else {
        Menu.buildFromTemplate([
          { label: '复制', role: 'copy', enabled: hasSelection },
          { type: 'separator' },
          {
            label: '全选',
            click: () => {
              mainWindow!.webContents.executeJavaScript(`
                (function() {
                  var el = document.querySelector('.note-content') || document.querySelector('.vditor-reset');
                  if (el) {
                    var range = document.createRange();
                    range.selectNodeContents(el);
                    var sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                  }
                })()
              `).catch(() => {});
            },
          },
        ]).popup();
      }
    }).catch(() => {});
  });

  // F5 / Ctrl+R 刷新, Ctrl+Shift+R 强刷
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F5' || (input.control && input.key === 'r')) {
      event.preventDefault();
      mainWindow?.webContents.reloadIgnoringCache();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 引用链接:应用内预览
    try {
      const u = new URL(url);
      const refId = u.searchParams.get('ref');
      if (refId) {
        mainWindow!.webContents.executeJavaScript(
          `document.querySelector('.note-ref-link[data-ref*="ref=${refId}"]')?.click()`
        ).catch(() => {});
        return { action: 'deny' };
      }
    } catch {}
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 拦截所有导航:同域走 SPA,外域用外部浏览器
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const u = new URL(url);
      const webOrigin = new URL(WEB_URL).origin;
      if (u.origin === webOrigin) {
        // 同域:SPA 内部导航
        event.preventDefault();
        const navPath = u.pathname + u.search;
        mainWindow!.webContents.executeJavaScript(
          `window.history.pushState(null,'','${navPath}');window.dispatchEvent(new PopStateEvent('popstate'))`
        ).catch(() => {});
      } else {
        // 外域:用外部浏览器打开
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
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
    height: 155,
    minWidth: 650,
    minHeight: 155,
    x: Math.round(screenWidth / 2 - 325),
    y: Math.round(screenHeight / 2 - 78),
    frame: false,
    resizable: false,
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
      label: `抓取选中文字  ${currentShortcuts.float}`,
      click: () => {
        // 延迟等托盘菜单关闭、焦点回到之前的应用
        setTimeout(() => triggerFloatWindow(), 200);
      },
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
  const win = BrowserWindow.fromWebContents(_event.sender);
  if (win) win.hide();
});

ipcMain.on('win-minimize', (_event) => {
  const win = BrowserWindow.fromWebContents(_event.sender);
  if (win) win.minimize();
});

ipcMain.on('win-maximize', (_event) => {
  const win = BrowserWindow.fromWebContents(_event.sender);
  if (win) {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
});

ipcMain.on('win-close', (_event) => {
  const win = BrowserWindow.fromWebContents(_event.sender);
  if (win) win.close();
});

ipcMain.on('note-saved', () => {
  // toast 显示在快捷弹窗原来的中心位置
  const bounds = captureWindow?.getBounds();
  if (bounds) {
    showToastAt('已保存', bounds.x + Math.round((bounds.width - 240) / 2), bounds.y + Math.round((bounds.height - 44) / 2));
  } else {
    showToast('已保存');
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('quink-note-created'))`
    ).catch(() => {});
  }
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
  if (!authToken) { console.log('[Float] no auth token, skip'); return; }

  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.close();
  }

  // 多显示器：找到鼠标所在的显示器
  const cursorDisplay = screen.getDisplayNearestPoint({ x, y });
  const bounds = cursorDisplay.workArea;
  const winW = 300;
  const winH = 32;
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
  try {
    nativeModuleRef = require(path.join(__dirname, '..', '..', 'native', 'index.js'));
    // 剪贴板 fallback 成功后回调,直接弹浮窗
    nativeModuleRef.onSelection((event: { text: string; x: number; y: number }) => {
      if (event.text && event.text.trim()) {
        showFloatWindow(event.text.trim(), event.x, event.y);
      }
    });
  } catch {
    console.log('Native module not available.');
  }

  console.log('Selection grabber ready.');
}

function grabAndShowFloat() {
  // 兜底方案：直接读剪贴板（需用户先 Ctrl+C）
  const text = clipboard.readText();
  if (text && text.trim()) {
    const pos = screen.getCursorScreenPoint();
    showFloatWindow(text.trim(), pos.x, pos.y);
  }
}

function tryStopSelectionMonitor() {}
