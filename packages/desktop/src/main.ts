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
import * as fs from 'fs';
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
// 主题持久化到 userData/theme-cache.json,让启动时立即用上次主题创建 tray + mainWindow icon,
// 否则要等 web 端 fetchMe + sync-theme IPC,首屏会看到默认 blueberry 闪一下再切到正确主题
let currentTheme = 'blueberry';

const themeCachePath = () => path.join(app.getPath('userData'), 'theme-cache.json');
function readCachedTheme(): string {
  try {
    const obj = JSON.parse(fs.readFileSync(themeCachePath(), 'utf8'));
    if (typeof obj?.theme === 'string') return obj.theme;
  } catch {}
  return 'blueberry';
}
function writeCachedTheme(theme: string) {
  try { fs.writeFileSync(themeCachePath(), JSON.stringify({ theme })); } catch {}
}

// 每个主题的 body 背景色（跟 style.css 的 --c-body 一致），用于快捷窗口的原生背景色
// 让 OS 显示窗口的瞬间，背景色已经跟即将渲染的内容一致，避免"主题切换后首次显示闪烁"
const THEME_BG: Record<string, string> = {
  blueberry: '#f4f5fc',
  lavender: '#f6f4fc',
  mint: '#f2fbf7',
  peach: '#fdf5f3',
  lemon: '#fcfaf0',
  cloud: '#f5f6f8',
  dark: '#131318',
};

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
    icon: createTrayIcon(currentTheme),
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
    maxWidth: 650,
    maxHeight: 155,
    x: Math.round(screenWidth / 2 - 325),
    y: Math.round(screenHeight / 2 - 78),
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: false,
    backgroundColor: THEME_BG[currentTheme] || '#ffffff',
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

async function toggleCaptureWindow() {
  if (!captureWindow) {
    await ensureCurrentTheme(); // 创建前同步主题，保证 backgroundColor 用最新值
    createCaptureWindow();
    // 等内容（Vditor）加载完再 show，避免用户看到布局跳变
    // 带 1500ms 超时兜底，防止 'content-ready' 未触发时窗口一直不显示
    let shown = false;
    const showOnce = () => {
      if (shown || !captureWindow || captureWindow.isDestroyed()) return;
      shown = true;
      captureWindow.show();
      captureWindow.focus();
    };
    ipcMain.once('content-ready', showOnce);
    // 超时兜底放长（dev 模式 Vite 首次编译 + Vditor 资源下载可能 > 1.5s）
    setTimeout(() => { showOnce(); ipcMain.removeListener('content-ready', showOnce); }, 3000);
    return;
  }

  if (captureWindow.isVisible()) {
    hideCaptureWindow();
  } else {
    // show 之前 await 同步主题，避免 sync-theme IPC 还没到时用户看到旧主题闪烁
    try {
      await captureWindow.webContents.executeJavaScript(
        `document.documentElement.setAttribute('data-theme', localStorage.getItem('quink_theme') || 'blueberry')`
      );
    } catch {}
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
  // reload-shortcuts 会重新调 createTray 刷新快捷键标签，要先销毁旧的，否则托盘项堆积
  if (tray && !tray.isDestroyed()) tray.destroy();
  const icon = createTrayIcon(currentTheme);
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

ipcMain.on('sync-theme', (_event, theme: string) => {
  currentTheme = theme;
  writeCachedTheme(theme);
  // 销毁快捷窗口：下次按快捷键时重新创建，新窗口直接用新主题色，
  // 彻底避免 hidden 窗口 GPU paint cache 残留旧主题导致的闪烁
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.destroy();
    captureWindow = null;
  }
  if (aiChatWindow && !aiChatWindow.isDestroyed()) {
    aiChatWindow.destroy();
    aiChatWindow = null;
  }
  // floatWindow 不受影响（生命周期不同），仍同步主题
  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.webContents.executeJavaScript(
      `document.documentElement.setAttribute('data-theme','${theme}')`
    ).catch(() => {});
    floatWindow.setBackgroundColor(THEME_BG[theme] || '#ffffff');
  }
  // 主窗口任务栏图标用 setIcon（窗口不会重复注册，setIcon 在 Win11 上安全）
  const themedIcon = createTrayIcon(theme);
  if (!themedIcon.isEmpty() && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIcon(themedIcon);
  }
  // 托盘：Win11 下 setImage 在某些场景会触发 NIM_DELETE+NIM_ADD 而非 NIM_MODIFY,
  // 表现为每切一次主题托盘项 +1 → 直接销毁重建,createTray 内部已 destroy 旧 tray
  createTray();
});

// 从主窗口的 localStorage 同步最新主题到主进程缓存（在创建快捷窗口前调用，
// 确保 captureWindow/aiChatWindow 的 backgroundColor 用最新主题色）
async function ensureCurrentTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const t = await mainWindow.webContents.executeJavaScript(
      `localStorage.getItem('quink_theme')`
    );
    if (t && typeof t === 'string') currentTheme = t;
  } catch {}
}

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
// 单实例锁:防止重复启动
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  // 必须在 createMainWindow / createTray 之前,这俩都用 currentTheme 决定图标
  currentTheme = readCachedTheme();
  createMainWindow();
  // 不在启动时预创建 captureWindow：那时 currentTheme 还是默认值（mainWindow 还没 fetchMe），
  // 预创建会让窗口 backgroundColor 用错误主题，导致首次按快捷键时 OS 显示几帧"上次主题色"
  // 等用户首次按 Shift+Space 时再创建，那时 currentTheme 已经被 sync-theme IPC 更新到正确值
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
  // 显式销毁托盘，避免某些 Windows 环境下应用退出后图标残留
  if (tray && !tray.isDestroyed()) tray.destroy();
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
    backgroundColor: THEME_BG[currentTheme] || '#ffffff',
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

async function toggleAiChatWindow() {
  if (!aiChatWindow) {
    await ensureCurrentTheme(); // 创建前同步主题，保证 backgroundColor 用最新值
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
    // show 之前 await 同步主题，避免 sync-theme IPC 还没到时用户看到旧主题闪烁
    try {
      await aiChatWindow.webContents.executeJavaScript(
        `document.documentElement.setAttribute('data-theme', localStorage.getItem('quink_theme') || 'blueberry')`
      );
    } catch {}
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
