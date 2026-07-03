import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  screen,
  ipcMain,
  shell,
  globalShortcut,
  clipboard,
  dialog,
  session,
  webContents,
  systemPreferences,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { createTrayIcon, createTrayImage } from './tray-icon';
import { registerShortcut, unregisterAll, startHook, stopHook, onKeydown } from './shortcuts';
import * as attachmentTasksStore from './attachmentTasksStore';
import { readServerConfig, writeServerConfig, ServerConfig } from './serverConfig';

// 默认值 = 本机模式 (local). app.whenReady 读 server-config.json 后 applyServerConfig 可能覆盖成远程地址.
// 改 let (不再 const): 下游 IPC handler / createWindow 都在运行时读, 启动时按 config 赋好值再建窗口.
let API_BASE = `http://localhost:${process.env.QUINK_PORT || '38999'}`;
// local-dev: 走 Vite dev server (24888, HMR). local-prod (打包后): server 同进程 SPA serve, 跟 API_BASE 同 origin (38999).
// remote: applyServerConfig 把两者都设成远程服务器地址, 前端从远程 origin 加载, API 相对路径自动跟到远程.
let WEB_URL = app.isPackaged
  ? API_BASE
  : `http://localhost:${process.env.QUINK_WEB_PORT || '24888'}`;

// 按 server-config.json 决定 API_BASE / WEB_URL.
// remote: 都指向远程服务器 → 前端从远程 origin 加载, API 相对路径自动打远程.
// local: 回本机默认 (dev 走 Vite 24888, prod 走内嵌 server 同 origin).
function applyServerConfig(cfg: ServerConfig) {
  if (cfg.mode === 'remote' && cfg.remoteUrl) {
    API_BASE = cfg.remoteUrl;
    WEB_URL = cfg.remoteUrl;
  } else {
    API_BASE = `http://localhost:${cfg.localPort || 38999}`;
    WEB_URL = app.isPackaged ? API_BASE : `http://localhost:${process.env.QUINK_WEB_PORT || '24888'}`;
  }
}

// 显式声明 app name. Electron 默认用 package.json 的 name (@quink/desktop), 导致
// userData 路径变成 %APPDATA%\@quink\desktop 难找. 显式设 Quink 让路径变 %APPDATA%\Quink.
// 必须在任何 app.getPath('userData') 调用之前 (HEIC_CACHE_DIR / PDF_CACHE_DIR 初始化用了它)
app.setName('Quink');

// ── 便携模式: 绿色版(zip)数据跟程序走 ──────────────────────────────
// 安装版 nsis 安装时在 exe 旁写 .installed 标记 → 数据用系统 %APPDATA%\Quink.
// 绿色版(zip 解压)没这标记 → 把 userData 指到 exe 旁 quink-data, 整个目录可拷走(笔记+登录态+主题都跟着).
// exe 旁不可写(误解压到 Program Files 等只读处)时兜底回退默认 %APPDATA%. dev 不受影响(!isPackaged).
if (app.isPackaged) {
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    if (!fs.existsSync(path.join(exeDir, '.installed'))) {
      const portableDir = path.join(exeDir, 'quink-data');
      fs.mkdirSync(portableDir, { recursive: true });
      fs.accessSync(portableDir, fs.constants.W_OK);
      app.setPath('userData', portableDir);
    }
  } catch {}
}

// ── 二合一: 内嵌 server (electron-as-node) 进程管理 ──────────────────
// 打包后桌面端自带 server-runtime (resources/server: server esbuild bundle + native(electron ABI) + 前端 SPA),
// app 启动时用 Electron 自带 node (ELECTRON_RUN_AS_NODE) 拉起 index.cjs, 退出时 kill.
// dev 模式不 spawn (用 pnpm dev:server 跑 tsx). 用户已自己跑 server (端口被占) 时复用现有, 不重复拉起.
let serverProcess: ChildProcess | null = null;

async function isServerUp(): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/api/health`);
    return r.ok;
  } catch {
    return false;
  }
}

function getServerDir(): string {
  // 打包后 server-runtime 放 resources/server (electron-builder extraResources: from server-runtime to server).
  // dev 回退到 packages/desktop/server-runtime (本地 prepare 脚本产物). dev 一般不 spawn 用不到, 仅占位.
  if (app.isPackaged) return path.join(process.resourcesPath, 'server');
  return path.join(__dirname, '..', 'server-runtime');
}

async function startServer(host: string, port: number): Promise<void> {
  if (!app.isPackaged) return; // dev: server 由 pnpm dev:server 跑, 不 spawn
  if (await isServerUp()) {
    console.log('[server] 已在运行, 复用现有');
    return;
  }
  const serverDir = getServerDir();
  const bundlePath = path.join(serverDir, 'index.cjs');
  if (!fs.existsSync(bundlePath)) {
    console.error('[server] 找不到 server bundle:', bundlePath);
    return;
  }
  console.log('[server] 拉起内嵌 server (electron-as-node):', bundlePath);
  // process.execPath = Electron 二进制. ELECTRON_RUN_AS_NODE=1 让它当纯 node 跑 server bundle.
  // NODE_PATH 指向随包 node_modules, bundle external 的 better-sqlite3/sharp 等 native 从这加载 (electron ABI).
  serverProcess = spawn(process.execPath, [bundlePath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      QUINK_DATA_DIR: app.getPath('userData'), // 数据落 userData, 重装/升级不丢
      QUINK_WEB_DIST: path.join(serverDir, 'web-dist'), // server 同进程 serve 前端 SPA
      QUINK_HOST: host, // local 模式 host: 127.0.0.1 锁本机 / 0.0.0.0 对局域网开放 (引导页"对局域网开放")
      QUINK_PORT: String(port),
      NODE_PATH: path.join(serverDir, 'node_modules'),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  serverProcess.on('exit', (code) => {
    console.log('[server] 退出, code=', code);
    serverProcess = null;
  });
  // 等 server ready (最多 30s) 再返回, 让窗口加载时后端已就绪, 避免白屏
  const start = Date.now();
  while (Date.now() - start < 30000) {
    if (await isServerUp()) {
      console.log('[server] ready');
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error('[server] 启动超时 30s, 仍继续建窗口');
}

function stopServer(): void {
  if (serverProcess) {
    try {
      serverProcess.kill();
    } catch {}
    serverProcess = null;
  }
}

// ── 自选服务器: 引导页 + 远程可达性 ──────────────────────────────
// 首次启动 (无 server-config.json) 或托盘"切换服务器"时弹. 纯本地 HTML (ui/setup.html), 不依赖任何 server.
function createSetupWindow(isFirstRun: boolean) {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 540,
    height: 480,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Quink - 选择服务器',
    icon: createTrayIcon(currentTheme),
    frame: false,
    show: false,
    backgroundColor: THEME_BG.blueberry,
    webPreferences: {
      preload: path.join(__dirname, 'preload-setup.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.loadFile(path.join(__dirname, '..', 'ui', 'setup.html'));
  setupWindow.once('ready-to-show', () => setupWindow?.show());
  setupWindow.on('closed', () => {
    setupWindow = null;
    // 首次启动 (还没写 config) 关掉引导 = 退出 app (没 config 进不了主界面).
    // 切换服务器 (已有 config) 关掉 = 仅关窗, 主窗口照常.
    if (isFirstRun && !readServerConfig()) app.quit();
  });
}

// 远程服务器可达性检测 (5s 超时). 启动时 + 引导页"测试连接"共用.
async function checkRemote(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${url.replace(/\/+$/, '')}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? '连接超时 (5 秒)' : e?.message || '无法连接' };
  }
}

// 远程模式连不上: 弹原生 dialog. 三个出口都不继续当前启动 (relaunch / 引导 / 退出 接管).
async function handleRemoteUnreachable(url: string) {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Quink',
    message: '连接服务器失败',
    detail: `无法连接到 ${url}\n服务器可能没开机, 或不在同一网络.`,
    buttons: ['重试', '切换服务器', '退出'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) {
    app.relaunch();
    app.exit(0);
  } else if (response === 1) {
    createSetupWindow(false);
  } else {
    app.quit();
  }
}

// 引导页 IPC
ipcMain.handle('setup:test-connection', (_e, url: string) => checkRemote(url));
ipcMain.handle('setup:get-current', () => readServerConfig());
ipcMain.on('setup:save', (_e, cfg: ServerConfig) => {
  writeServerConfig(cfg);
  // origin (远程地址) / host (对局域网开放) 变了, 必须重启 app 重新走启动分支 + 重新 loadURL
  app.relaunch();
  app.exit(0);
});

let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let floatWindow: BrowserWindow | null = null;
let lastFloatText = ''; // 最近一次弹 float 用的文字, toggle 关闭后再按却读不到选中时兜底重弹
let translateWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let authToken: string | null = null;
let aiChatWindow: BrowserWindow | null = null;

// 默认快捷键
// Windows: 单修饰好按. macOS: ⌘⇧ 双修饰 (避开系统 ⌘Q 退出 / ⌘Space 聚焦 / ⌘⇧Q 注销 / ⌘⇧3-5 截图), Meta=Command.
const DEFAULT_SHORTCUTS = process.platform === 'darwin' ? {
  capture: 'Meta+Shift+Space',
  aiChat: 'Meta+Shift+A',
  float: 'Meta+Shift+X',
} : {
  capture: 'Shift+Space',
  aiChat: 'Alt+Space',
  float: 'Alt+Q',
};

let currentShortcuts = { ...DEFAULT_SHORTCUTS };

// 快捷键显示美化: macOS 用符号 ⌘⇧⌥⌃ 连写 (Meta+Shift+Space → ⌘⇧Space), 其他平台原样.
function fmtShortcut(s: string): string {
  if (process.platform !== 'darwin') return s;
  return s.replace(/Meta/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt/g, '⌥').replace(/Ctrl/g, '⌃').replace(/\+/g, '');
}
let nativeModuleRef: any = null;
// 主题持久化到 userData/theme-cache.json,让启动时立即用上次主题创建 tray + mainWindow icon,
// 否则要等 web 端 fetchMe + sync-theme IPC,首屏会看到默认 blueberry 闪一下再切到正确主题
let currentTheme = 'blueberry';
// 下载目录: 默认 ~/Downloads, renderer 端 (Settings 配置) 通过 IPC sync-download-path 推到这里
let currentDownloadDir = app.getPath('downloads');
// 当前用户显示比例 (默认 100%, 8 档 75/80/90/100/110/125/150/200), 用于 Capture 窗口尺寸按比例缩放
// + 通过 webContents.setZoomFactor(level/100) 应用到 3 个窗口. zoom 跟老 fontSize 的区别详见根 RENDERING-PITFALLS.md.
let currentZoomLevel = 100;

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

// 每个主题的侧边栏色(跟 style.css --c-sidebar 一致). Windows float 实色窗口背景用它 → 整窗一块 sidebar 色圆角矩形
const THEME_SIDEBAR: Record<string, string> = {
  blueberry: '#f0f2ff',
  lavender: '#f5f0ff',
  mint: '#eefcf7',
  peach: '#fff4f2',
  lemon: '#fffcf0',
  cloud: '#f5f7fa',
  dark: '#16161e',
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
      // macOS: preferences 里存的 Windows 风格快捷键 (含 Ctrl/Alt 非 Meta) 在 Mac 上不顺手, 回退 Mac 默认.
      // (同账号跨平台同步 preferences, Windows 设的 Ctrl+Shift+Space 不该套到 Mac)
      if (process.platform === 'darwin') {
        for (const k of ['capture', 'aiChat', 'float'] as const) {
          const v = currentShortcuts[k];
          if (v && /\b(Ctrl|Alt)\b/.test(v) && !v.includes('Meta')) {
            currentShortcuts[k] = DEFAULT_SHORTCUTS[k];
          }
        }
      }
    }
    if (prefs?.theme && typeof prefs.theme === 'string') {
      currentTheme = prefs.theme;
    }
  } catch {}
}

// macOS: 全局快捷键 (uiohook) 需"辅助功能"权限. startHook 失败时弹窗引导用户授权 + 打开系统设置对应页.
function promptAccessibilityPermission() {
  if (process.platform !== 'darwin') return;
  if (systemPreferences.isTrustedAccessibilityClient(false)) return; // 已授权, 失败是别的原因, 不弹
  dialog.showMessageBox({
    type: 'info',
    title: 'Quink 需要"辅助功能"权限',
    message: '全局快捷键需要"辅助功能"权限',
    detail: '快速记录 / AI 对话 / 抓取选中 等全局快捷键, 需在\n系统设置 → 隐私与安全性 → 辅助功能\n打开 Quink 的开关, 然后重启 Quink。',
    buttons: ['打开系统设置', '稍后'],
    defaultId: 0,
  }).then(({ response }) => {
    if (response === 0) {
      systemPreferences.isTrustedAccessibilityClient(true); // 触发系统把 Quink 加进辅助功能列表
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
  });
}

// 快捷键开关: 开着就关; 没开就立即弹窗 (胶囊上是静态按钮, 不显示选中文字本身 → 窗口无需等读取, 秒开),
// 选中文字后台异步读进去 (点按钮时才真正用到文字, 那时早读完了). 反复开关同一段不会每次卡在读取上.
async function triggerFloatWindow() {
  if (floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible()) {
    floatWindow.hide();
    return;
  }
  showFloatWindow(lastFloatText); // 先用上次文字占位立即弹
  refreshFloatSelection();         // 再后台读当前选中, 读到就更新
}

// 读当前选中文字, 更新到已弹出的 float (不重新弹/不重定位). UIA 无感优先, 失败 Ctrl+C 兜底
async function refreshFloatSelection() {
  if (nativeModuleRef?.readSelectionUia) {
    try {
      const sel = await nativeModuleRef.readSelectionUia();
      const t = sel?.text?.trim();
      if (t && t.length >= 1 && !isOwnWindow(sel.hwnd)) {
        updateFloatText(t);
        return;
      }
    } catch (e) {
      console.log('[Float] UIA read failed:', e);
    }
  }
  // UIA 没读到 → Ctrl+C 兜底 (记事本/老 Win32/Qt): grabSelection 异步结果走 onSelection → updateFloatText;
  // 无 native 则直接读剪贴板
  if (nativeModuleRef?.grabSelection) {
    nativeModuleRef.grabSelection();
  } else {
    const t = clipboard.readText();
    if (t && t.trim()) updateFloatText(t.trim());
  }
}

// 只把选中文字更新到已弹出的 float (IPC 推文字 + 更新缓存), 不重新定位/show
function updateFloatText(text: string) {
  lastFloatText = text;
  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.webContents.send('float-text', text.slice(0, 2000));
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
    // Mac 用原生交通灯 (hiddenInset 隐藏标题栏背景但保留红绿灯按钮), Windows 用 frame:false 自绘标题栏.
    // trafficLightPosition 让交通灯垂直居中到前端 36px 自绘标题栏内 (y=(36-14)/2≈11)
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 11 } }
      : { frame: false }),
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

  // 远程模式主文档加载失败 (服务器中途挂 / 网络断) 兜底: 弹 dialog 让用户重试/换服务器.
  // 只认主 frame 失败, 排除 -3 (ERR_ABORTED, 正常导航取消会报). 本机模式不弹 (server await ready 后才建窗口).
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, _desc, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const cfg = readServerConfig();
    if (cfg?.mode === 'remote') handleRemoteUnreachable(cfg.remoteUrl);
  });

  // 右键上下文菜单
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const hasSelection = params.selectionText.length > 0;

    // editable (input/textarea/contenteditable) 全局都显示编辑菜单 — 不限 .note-content;
    // AI 搜索框 / TopBar 搜索 / 各 modal input 等都受益
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { label: '剪切', role: 'cut', enabled: hasSelection },
        { label: '复制', role: 'copy', enabled: hasSelection },
        { label: '粘贴', role: 'paste' },
        { type: 'separator' },
        { label: '全选', role: 'selectAll' },
      ]).popup();
      return;
    }

    // 非 editable: 检测命中范围 (异步 IPC 查 DOM)
    // - .note-content 内 → 列表卡片 / 详情笔记的正文卡 → 弹
    // - 详情页 main 灰区 (main 子树含 .note-detail-content) → 弹 (详情卡片可能很短, 灰区也算"内容详情里")
    // - 有 selection (无论命中) → 弹 (用户选完字鼠标移到任何位置都可复制)
    // - audio/image anchor 区域: 跳过 (web 端 MediaContextMenu 接管, 弹"下载/播放" 菜单)
    mainWindow!.webContents.executeJavaScript(`
      (function() {
        var el = document.elementFromPoint(${params.x}, ${params.y});
        if (!el) return { inArea: false, isMedia: false };
        // audio anchor / 图片: 让 web 端 MediaContextMenu 接管 (弹自定义"下载音频/播放/重新播放" 菜单)
        var a = el.closest && el.closest('a');
        if (a) {
          var href = a.getAttribute('href') || '';
          if (/\\.(m4a|mp3|wav|webm|ogg)(\\?|$)/i.test(href)) return { inArea: false, isMedia: true };
        }
        if (el.tagName === 'IMG' && el.closest('.note-content')) return { inArea: false, isMedia: true };
        var inArea = false;
        if (el.closest('.note-content')) inArea = true;
        else {
          var main = el.closest('main');
          if (main && main.querySelector('.note-detail-content')) inArea = true;
        }
        return { inArea: inArea, isMedia: false };
      })()
    `).then((result: { inArea: boolean; isMedia: boolean }) => {
      // isMedia: web 端菜单接管, Electron 不弹 (防双菜单重叠用户看不到下载选项)
      if (result.isMedia) return;
      const inArea = result.inArea;
      if (!hasSelection && !inArea) return;
      Menu.buildFromTemplate([
        { label: '复制', role: 'copy', enabled: hasSelection },
        { type: 'separator' },
        {
          label: '全选',
          click: () => {
            // 全选 = 笔记正文区 (.vditor-reset), 跳过外层类型/分类/时间/summary/tags
            // 列表多卡片场景: elementFromPoint 找当前卡, 不要 querySelector (永远拿第一个)
            // 详情页 main 灰区右键: pt 是 MAIN, closest('.note-content') = null → fallback 到 .note-detail-content
            mainWindow!.webContents.executeJavaScript(`
              (function() {
                var pt = document.elementFromPoint(${params.x}, ${params.y});
                var card = pt && pt.closest('.note-content');
                if (!card) card = document.querySelector('.note-detail-content');
                if (!card) return;
                var target = card.querySelector('.vditor-reset') || card;
                var range = document.createRange();
                range.selectNodeContents(target);
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
              })()
            `).catch(() => {});
          },
        },
      ]).popup();
    }).catch(() => {});
  });

  // F5 / Ctrl+R 刷新, Ctrl+Shift+R 强刷
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F5' || (input.control && input.key === 'r')) {
      event.preventDefault();
      mainWindow?.webContents.reloadIgnoringCache();
    }
  });

  // 阻止 Ctrl+滚轮触发 Chromium 内置 zoom (用户改显示比例必须走 Settings, 避免双入口同步偏差)
  hookZoomChanged(mainWindow);

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
  const { width, height } = getCaptureSize(currentZoomLevel);

  captureWindow = new BrowserWindow({
    width,
    height,
    minWidth: width,
    minHeight: height,
    maxWidth: width,
    maxHeight: height,
    x: Math.round(screenWidth / 2 - width / 2),
    y: Math.round(screenHeight / 2 - height / 2),
    frame: false,
    resizable: true,
    maximizable: false,
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
  hookZoomChanged(captureWindow);
  // 新窗口 webContents zoom factor 默认 1.0, 物理 size 跟着 currentZoomLevel 算 (getCaptureSize),
  // 不显式 setZoomFactor 会导致物理跟 factor 不匹配 → 内容跟窗口边框不对齐.
  // did-finish-load 而非 dom-ready: 后者 setZoomFactor 可能被 navigation 完成时 reset, did-finish-load
  // 是最终 load 完, setZoomFactor 持久生效
  captureWindow.webContents.once('did-finish-load', () => {
    if (!captureWindow || captureWindow.isDestroyed()) return;
    applyZoomToWebContents(captureWindow.webContents, currentZoomLevel / 100);
  });

  captureWindow.on('closed', () => {
    captureWindow = null;
  });
}

async function toggleCaptureWindow() {
  if (!captureWindow) {
    await ensureCurrentTheme(); // 创建前同步主题，保证 backgroundColor 用最新值
    await ensureCurrentZoomLevel(); // 同步显示比例,保证窗口初始 height 正确
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
    // 强制重新对齐 bounds + zoom: hide 期间用户改 zoom (sync-zoom IPC) 时窗口在 hide 状态,
    // OS 对 hidden window 的 setBounds + setZoomFactor 可能延迟/忽略 → 下次 show 时窗口物理或 dpr
    // 是旧的 → 内容跟边框不对齐 / dpr 跟物理不匹配 (实测: 100% 正常, <100% 多空白, >100% 显示不完整).
    // 双层 align:
    //   1. show 前 align (优化, 让 show 时窗口尽量对, 避免可见 size 闪烁)
    //   2. once('show') 内 align (兜底, show 事件 fire 时窗口已 visible, setBounds + setZoomFactor
    //      可靠生效, 任何 hide 期间没生效的状态此时被强制对齐)
    alignCaptureToZoom(currentZoomLevel);
    captureWindow.once('show', () => alignCaptureToZoom(currentZoomLevel));
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
  const icon = createTrayImage(currentTheme);
  tray = new Tray(icon);
  tray.setToolTip('Quink - 一念');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开 Quink',
      click: () => showMainWindow(),
    },
    {
      label: `快速记录  ${fmtShortcut(currentShortcuts.capture)}`,
      click: () => toggleCaptureWindow(),
    },
    {
      label: `AI 对话  ${fmtShortcut(currentShortcuts.aiChat)}`,
      click: () => toggleAiChatWindow(),
    },
    {
      label: `抓取选中文字  ${fmtShortcut(currentShortcuts.float)}`,
      click: () => {
        // 延迟等托盘菜单关闭、焦点回到之前的应用
        setTimeout(() => triggerFloatWindow(), 200);
      },
    },
    { type: 'separator' },
    {
      label: '切换服务器',
      click: () => createSetupWindow(false),
    },
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
// 资源页/右键下载文件 → 走 Electron webContents.downloadURL 主动下载,
// 不依赖 programmatic <a download> click 的 user activation (audio/video/pdf INLINE mime 后, await fetch 让 user activation 过期, a.click() 不 trusted)
// URL 必须 absolute (浏览器解析相对路径靠 location.origin, Electron API 直接传入相对路径不可靠)
ipcMain.on('download-url', (event, url: string) => {
  const wc = BrowserWindow.fromWebContents(event.sender)?.webContents;
  if (wc) wc.downloadURL(url);
});

// dock "打开所在文件夹" 按钮 → shell.showItemInFolder(savePath). url 作 key 查 task.savePath
ipcMain.on('show-in-folder', (_event, url: string) => {
  const savePath = attachmentTasksStore.getSavePathByUrl(url);
  if (savePath && fs.existsSync(savePath)) shell.showItemInFolder(savePath);
});

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
      // 带 noteId 时主窗口 listener 走单条 AI 结果轮询 patch (不重排), 不带则回退全量 fetchNotes
      const noteId = data.data?.id;
      const detail = noteId ? `, { detail: { id: ${JSON.stringify(noteId)} } }` : '';
      mainWindow.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('quink-note-created'${detail}))`
      ).catch(() => {});
    }

    return { success: true, data: data.data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 点击笔记里的附件链接(/api/uploads/xxx.md 等)时,fetch 文件到 OS 临时目录 +
// shell.openPath 用系统默认应用打开。原始的"a.href 浏览器跳转"在 Electron 内嵌
// chromium 下对 text/markdown 等 mime 显示空白页,所以 web 端拦截后转发到这里。
//
// 两层去重: inflight map(同一 URL 并发只跑一次 fetch) + cache map(下载过的二次点击秒开)
const attachmentInflight = new Map<string, Promise<{ success: boolean; error?: string; cancelled?: boolean }>>();
const attachmentCache = new Map<string, string>(); // URL → 本地临时路径
// 取消支持: open-attachment 注册 controller, cancel-attachment IPC 通过 URL 找到对应 controller 调 abort()
const attachmentControllers = new Map<string, AbortController>();

// 15 秒没新 chunk 视为下载停滞,abort fetch 让用户看到错误而非永远转圈
const ATTACHMENT_STALL_MS = 15000;
// 推送进度的最小间隔(throttle),避免每个 chunk 都 IPC + 触发 Vue reactive 造成 toast 闪烁
const PROGRESS_THROTTLE_MS = 100;

ipcMain.handle('open-attachment', async (event, url: string) => {
  const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;
  if (attachmentInflight.has(fullUrl)) return attachmentInflight.get(fullUrl)!;

  const task = (async () => {
    let stallChecker: NodeJS.Timeout | null = null;
    const sender = event.sender;
    // cancelled 标志区分"用户主动取消"vs"下载停滞超时", 提到 try 块外让 catch 能访问
    let cancelledByUser = false;
    try {
      // 缓存命中: 文件还在临时目录就直接 openPath, 跳过 fetch.
      // task 可能不存在 (App.vue 走 openedAttachments 静默分支) 或处于 downloading (reopen 流程),
      // markSuccessByUrl 内部按 status=downloading 过滤, 没 task / 已 success 都是 no-op
      const cached = attachmentCache.get(fullUrl);
      if (cached && fs.existsSync(cached)) {
        const err = await shell.openPath(cached);
        if (err) throw new Error(err);
        attachmentTasksStore.markSuccessByUrl(fullUrl);
        return { success: true, cached: true };
      }

      const controller = new AbortController();
      attachmentControllers.set(fullUrl, controller);
      let lastProgressAt = Date.now();
      let lastEmitAt = 0;
      (controller as any).__cancelMark = () => { cancelledByUser = true; };
      stallChecker = setInterval(() => {
        if (Date.now() - lastProgressAt > ATTACHMENT_STALL_MS) controller.abort();
      }, 1000);

      const res = await fetch(fullUrl, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        lastProgressAt = Date.now();
        if (lastProgressAt - lastEmitAt > PROGRESS_THROTTLE_MS) {
          lastEmitAt = lastProgressAt;
          // 进度走 store 广播 (所有窗口同步) 替代原 sender.send 单点推
          attachmentTasksStore.updateProgressByUrl(fullUrl, received, total);
        }
      }
      // 最终 100% 状态推一次 (throttle 可能丢了最后一帧)
      attachmentTasksStore.updateProgressByUrl(fullUrl, received, total || received);

      const buffer = Buffer.concat(chunks);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quink-attachment-'));
      const filename = decodeURIComponent(path.basename(new URL(fullUrl).pathname));
      const filePath = path.join(tmpDir, filename);
      fs.writeFileSync(filePath, buffer);
      attachmentCache.set(fullUrl, filePath);
      const err = await shell.openPath(filePath);
      if (err) throw new Error(err);
      attachmentTasksStore.markSuccessByUrl(fullUrl);
      return { success: true };
    } catch (e: any) {
      // AbortError 两个来源: 用户主动 cancel(cancelledByUser=true) / stall 超时. 前者不算错误
      if (e?.name === 'AbortError' || /abort/i.test(e?.message || '')) {
        if (cancelledByUser) {
          attachmentTasksStore.removeByUrl(fullUrl);
          return { success: false, cancelled: true };
        }
        const stallErr = `下载停滞(${ATTACHMENT_STALL_MS / 1000} 秒无响应)`;
        attachmentTasksStore.markFailedByUrl(fullUrl, stallErr);
        return { success: false, error: stallErr };
      }
      const errMsg = e?.message || String(e);
      attachmentTasksStore.markFailedByUrl(fullUrl, errMsg);
      return { success: false, error: errMsg };
    } finally {
      if (stallChecker) clearInterval(stallChecker);
      attachmentInflight.delete(fullUrl);
      attachmentControllers.delete(fullUrl);
    }
  })();
  attachmentInflight.set(fullUrl, task);
  return task;
});

// PDF 首页缩略图持久化缓存. pdfjs 渲染 PDF 首页耗 CPU, 同一文件多次进资源页一直重算浪费.
// 文件存 userData/pdf-thumb-cache/<basename>.jpg
// (HEIC 已经走后端转码生成 .thumb.jpg, 不再需要客户端持久化)
const PDF_CACHE_DIR = path.join(app.getPath('userData'), 'pdf-thumb-cache');
try { fs.mkdirSync(PDF_CACHE_DIR, { recursive: true }); } catch {}

function pdfThumbCacheFilename(url: string): string {
  return path.basename(url) + '.jpg';
}

ipcMain.handle('pdf-thumb-cache:get', (_event, url: string): Buffer | null => {
  const p = path.join(PDF_CACHE_DIR, pdfThumbCacheFilename(url));
  if (!fs.existsSync(p)) return null;
  try { return fs.readFileSync(p); } catch { return null; }
});

ipcMain.handle('pdf-thumb-cache:put', (_event, url: string, data: ArrayBuffer): boolean => {
  try {
    fs.writeFileSync(path.join(PDF_CACHE_DIR, pdfThumbCacheFilename(url)), Buffer.from(data));
    return true;
  } catch (e) {
    console.error('[pdf-thumb-cache:put]', e);
    return false;
  }
});

// 视频首帧缩略图持久化缓存. 渲染端用 <video> + canvas drawImage 取首帧, IPC put 写盘.
// 跟 PDF/HEIC 同 pattern. 优势: list/grid view 缓存命中后用 <img> 显示, 0 个 <video> 媒体 pipeline 占用
const VIDEO_THUMB_CACHE_DIR = path.join(app.getPath('userData'), 'video-thumb-cache');
try { fs.mkdirSync(VIDEO_THUMB_CACHE_DIR, { recursive: true }); } catch {}

function videoThumbCacheFilename(url: string): string {
  return path.basename(url) + '.jpg';
}

ipcMain.handle('video-thumb-cache:get', (_event, url: string): Buffer | null => {
  const p = path.join(VIDEO_THUMB_CACHE_DIR, videoThumbCacheFilename(url));
  if (!fs.existsSync(p)) return null;
  try { return fs.readFileSync(p); } catch { return null; }
});

ipcMain.handle('video-thumb-cache:put', (_event, url: string, data: ArrayBuffer): boolean => {
  try {
    fs.writeFileSync(path.join(VIDEO_THUMB_CACHE_DIR, videoThumbCacheFilename(url)), Buffer.from(data));
    return true;
  } catch (e) {
    console.error('[video-thumb-cache:put]', e);
    return false;
  }
});

// 取消正在下载的附件: 找到对应 AbortController 调 abort(). __cancelMark 让 open-attachment 的
// catch 分支区分"用户主动取消"vs"stall 超时", 前者返回 cancelled: true 不算错误
ipcMain.handle('cancel-attachment', (_event, url: string) => {
  const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;
  const controller = attachmentControllers.get(fullUrl);
  if (!controller) return { success: false };
  (controller as any).__cancelMark?.();
  controller.abort();
  return { success: true };
});

// ===== 全局附件传输任务 (跨窗口共享, attachmentTasksStore 维护) =====
// 任何 BrowserWindow 都通过这套 IPC 改 task 状态, store 内 broadcast 给所有 webContents 同步.
ipcMain.handle('attachment-tasks:get', () => attachmentTasksStore.getAll());

// add: 入参 task 完整字段; 返回 main 端实际使用的 id (同 URL download 会复用已有 id, 不一定等于入参 id)
ipcMain.handle('attachment-tasks:add', (_e, task: attachmentTasksStore.PersistedTask) =>
  attachmentTasksStore.add(task)
);

ipcMain.on('attachment-tasks:update-progress', (_e, payload: { id: string; received: number; total: number }) =>
  attachmentTasksStore.updateProgress(payload.id, payload.received, payload.total)
);

ipcMain.on('attachment-tasks:mark-success', (_e, id: string) => attachmentTasksStore.markSuccessById(id));
ipcMain.on('attachment-tasks:mark-failed', (_e, payload: { id: string; error: string }) =>
  attachmentTasksStore.markFailedById(payload.id, payload.error)
);
ipcMain.on('attachment-tasks:remove', (_e, id: string) => attachmentTasksStore.removeById(id));
ipcMain.on('attachment-tasks:clear-completed', () => attachmentTasksStore.clearCompleted());

// 提醒通道: renderer 收到 SSE reminder 事件后转发到这里, 用 Electron 原生 Notification (任务栏图标会闪 + Win11 通知中心收纳)
// 点击通知 → 激活主窗口 + IPC 转发让 renderer 跳详情页. noteId 透传给 renderer.
ipcMain.on('show-notification', (_e, payload: { title: string; body: string; noteId?: string; path?: string }) => {
  if (!Notification.isSupported()) {
    console.warn('[notification] OS 不支持系统通知');
    return;
  }
  const n = new Notification({
    title: payload.title || 'Quink 提醒',
    body: payload.body || '',
    silent: false,
  });
  n.on('click', () => {
    // 激活主窗口 + 跳转: path 优先 (群组等通用场景), noteId 老 reminder 兼容
    // 加强防御 ("点击不激活" 问题): 100ms→250ms 给 OS 更长完成时间, webContents.focus() 让 Chromium DOM 也接 OS 激活
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      // Win32 SetForegroundWindow lock 防御:
      //   1. setAlwaysOnTop(true) 临时拉到顶绕开 foreground lock
      //   2. focus() 让 OS hwnd 激活
      //   3. webContents.focus() 让 Chromium 内部对 DOM focus 触发 OS hwnd 二次激活 (跟持久窗口 hide→show 同款救活)
      //   4. 250ms 后取消 alwaysOnTop (100ms 在低端机 / Win11 任务繁忙时不够, 偶发不激活)
      mainWindow.setAlwaysOnTop(true);
      mainWindow.focus();
      mainWindow.webContents.focus();
      setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false); }, 250);
      if (payload.path) {
        mainWindow.webContents.send('open-path', payload.path);
      } else if (payload.noteId) {
        mainWindow.webContents.send('open-note', payload.noteId);
      }
    }
  });
  n.show();
});

// close: abort 所有 inflight (download main 端自己 abort; upload broadcast 让发起 renderer abort 本地 controller) + 清空
ipcMain.on('attachment-tasks:close', () => {
  // 1. abort main 端所有 inflight download fetch
  for (const url of attachmentTasksStore.getInflightDownloadUrls()) {
    const ctrl = attachmentControllers.get(url);
    if (ctrl) {
      (ctrl as any).__cancelMark?.();
      try { ctrl.abort(); } catch {}
    }
  }
  // 2. broadcast 让所有 renderer 检查本地 upload AbortController Map abort
  const uploadIds = attachmentTasksStore.getInflightUploadIds();
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    try { wc.send('attachment-tasks:abort-uploads', uploadIds); } catch {}
  }
  // 3. 清空 + broadcast sync
  attachmentTasksStore.closeAll();
});

// cancel: 跟 close 类似但仅对一条. download → main abort fetch; upload → broadcast 让 renderer abort
ipcMain.on('attachment-tasks:cancel', (_e, id: string) => {
  const all = attachmentTasksStore.getAll();
  const t = all.find((x) => x.id === id);
  if (!t) return;
  if (t.status !== 'downloading') {
    attachmentTasksStore.removeById(id);
    return;
  }
  if (t.kind === 'download') {
    // 跟 cancel-attachment IPC 同逻辑, 但走 store 的状态
    const ctrl = attachmentControllers.get(t.url);
    if (ctrl) {
      (ctrl as any).__cancelMark?.();
      try { ctrl.abort(); } catch {}
    }
    // fetch 的 catch 分支会调 store.removeByUrl, 这里不重复
  } else {
    // upload: broadcast 让所有窗口检查本地 controller, 发起者 abort 后调 removeById
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      try { wc.send('attachment-tasks:abort-uploads', [id]); } catch {}
    }
    attachmentTasksStore.removeById(id);
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

ipcMain.on('note-saved', (_event, noteId?: string) => {
  // toast 显示在快捷弹窗原来的中心位置
  const bounds = captureWindow?.getBounds();
  if (bounds) {
    showToastAt('已保存', bounds.x + Math.round((bounds.width - 240) / 2), bounds.y + Math.round((bounds.height - 44) / 2));
  } else {
    showToast('已保存');
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 带 noteId 时主窗口 listener 走单条 AI 结果轮询 patch (不重排), 不带则回退全量 fetchNotes
    const detail = noteId ? `, { detail: { id: ${JSON.stringify(noteId)} } }` : '';
    mainWindow.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('quink-note-created'${detail}))`
    ).catch(() => {});
  }
});

// 所有 BrowserWindow (主窗口 / Capture / AiChat) 里 Ctrl+滚轮 → Chromium 触发 webContents 'zoom-changed'
// 事件. main 端 preventDefault 阻 Chromium 内置 layout zoom (renderer 的 DOM preventDefault 阻不了, 详见
// packages/desktop/CLAUDE.md zoom 段). 不再转发到主窗口 → Quink 显示比例只能从 Settings 改, Ctrl+滚轮静默忽略.
// (历史: 之前转发给主窗口走 stepZoom 链路, 但 wheel zoom 跟 settings zoom 两个入口偶发不同步导致 Capture/AiChat
// 内容跟窗口边框不对齐, 收敛到单一入口避免)
function hookZoomChanged(win: BrowserWindow) {
  win.webContents.on('zoom-changed', (e) => {
    e.preventDefault();
  });
}

ipcMain.on('sync-token', (_event, token: string | null) => {
  authToken = token;
  if (token) {
    loadUserShortcuts().then(() => applyShortcuts());
  }
});

// renderer 端 (Settings 改下载目录) 把路径推过来, will-download 用这个路径直接 setSavePath
ipcMain.on('sync-download-path', (_event, dirPath: string) => {
  if (dirPath && typeof dirPath === 'string') currentDownloadDir = dirPath;
});

// 设置页显示"系统默认"的真实路径(Windows: C:\Users\xxx\Downloads, macOS/Linux: ~/Downloads)
ipcMain.handle('get-default-download-dir', () => app.getPath('downloads'));

// 设置页选下载目录: 弹系统目录选择对话框, 返回选中路径或 null
ipcMain.handle('pick-directory', async (event): Promise<string | null> => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win || undefined as any, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择下载文件夹',
    defaultPath: currentDownloadDir,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// 用户改显示比例: 调整 currentZoomLevel + Capture 窗口尺寸 (宽+高) + 给所有 3 个窗口 setZoomFactor.
// zoom 是 paint 层等比 scale, renderer 不再需要监听 font-size-changed 自己改 fontSize.
// 关键: 先 setZoomLevel(0) 清掉 Chromium per-origin 持久化 zoom (Ctrl+滚轮在快捷窗口里会改 origin zoom),
// 否则 setZoomFactor(1.0) 调成功了但 origin 层级仍是 1.1/2.0 等残留, 实际 zoom 不变. 顺序 setZoomLevel 必须在 setZoomFactor 之前
function applyZoomToWebContents(wc: Electron.WebContents, factor: number) {
  wc.setZoomLevel(0);
  wc.setZoomFactor(factor);
}

// 主窗口物理尺寸跟 zoom 联动:
//   - setBounds 按用户当前窗口 × (newFactor / oldFactor) 缩放, 保留用户拖动的相对尺寸 + 屏幕居中
//   - setMinimumSize 按 CSS px 基准 × factor 算 (跟 zoom 走), 不同 zoom 下 viewport CSS px 一致
// 启动时 lastMainZoom=100, current=createMainWindow 的 1280×860 当 "标准值" 基准. 之后用户每次改 zoom
// 按当前实际窗口缩放, 不再用屏幕 60% 等硬基准
let lastMainZoom = 100;
// CSS px 基准:
//   W=900 保证 sidebar (md: breakpoint 768) + 编辑器 toolbar 不被挤
//   H=W × 屏幕宽高比 × 1.1 (基础按屏幕比例算, 多加 10% bonus 让 sidebar 分类至少几行可见 — 原始比例算
//   的 16:9 屏 506 太短 zoom 缩小时分类消失, +10% → ~557 够)
const MAIN_MIN_CSS_W = 900;
const MAIN_MIN_H_BONUS = 1.1;
function applyMainWindowZoomSize(zoomLevel: number) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const factor = zoomLevel / 100;
  const lastFactor = lastMainZoom / 100;
  const ratio = factor / lastFactor;
  // F5 / 重复 syncZoom 时 ratio === 1 (实际未缩放): 跳过 setBounds 保持窗口当前位置/大小,
  // 否则用户拖到非中央的窗口会被强制居中 (F5 后窗口归位最中间).
  // setMinimumSize 上次设过的也还在 (lastMainZoom 不变意味着 minW/minH 也没变), 跳过 OK.
  if (Math.abs(ratio - 1) < 0.001) return;
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const cur = mainWindow.getBounds();
  // setBounds 按用户当前窗口 × ratio 缩放, 但保证 ≥ MIN_CSS × factor (防 zoom 缩小时 sidebar 分类显示不下)
  const minW = Math.round(MAIN_MIN_CSS_W * factor);
  const minH = Math.round(MAIN_MIN_CSS_W * (screenH / screenW) * MAIN_MIN_H_BONUS * factor);
  let W = Math.max(Math.round(cur.width * ratio), minW);
  let H = Math.max(Math.round(cur.height * ratio), minH);
  // cap 屏幕 95% 防超屏
  W = Math.min(W, Math.round(screenW * 0.95));
  H = Math.min(H, Math.round(screenH * 0.95));
  // 居中 (从中间向四周, settings 改 zoom 用户预期窗口"原地"变化, 不应跑偏)
  const x = Math.round((screenW - W) / 2);
  const y = Math.round((screenH - H) / 2);
  // setMinimumSize cap 到 W/H 防 OS 冲突 (min 不能 > 当前 bounds, 上面 cap 触发屏幕 95% 时 W/H 可能 < MIN_CSS × factor)
  mainWindow.setMinimumSize(Math.min(minW, W), Math.min(minH, H));
  mainWindow.setBounds({ x, y, width: W, height: H });
  lastMainZoom = zoomLevel;
}
// Capture / AiChat 跟 zoom 对齐 (bounds + setZoomFactor). 抽出来给两个入口共用:
//   1. sync-zoom IPC: 用户改 zoom 时同步给所有窗口
//   2. toggleCaptureWindow / toggleAiChatWindow: 每次 show 前重新对齐, 防 hide 期间 setBounds 被 OS 延迟/
//      忽略导致下次 show 时窗口物理跟 zoom factor 不一致 (内容跟边框留白 / 被裁的根因)
function alignCaptureToZoom(level: number) {
  if (!captureWindow || captureWindow.isDestroyed()) return;
  const { width: w, height: h } = getCaptureSize(level);
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  // 先放开 min/max 限制再 setBounds,否则锁死的尺寸不让改
  captureWindow.setMinimumSize(w, h);
  captureWindow.setMaximumSize(w, h);
  captureWindow.setBounds({
    x: Math.round(screenWidth / 2 - w / 2),
    y: Math.round(screenHeight / 2 - h / 2),
    width: w,
    height: h,
  });
  applyZoomToWebContents(captureWindow.webContents, level / 100);
}
// AiChat 跟 Capture 一样按基准 × factor 重置物理尺寸 + 内容 zoom (覆盖用户拖动的自定义尺寸).
// 区别: 仍可 resize (不锁 max), 用户改 zoom 后可继续拖大. minWidth/minHeight 也按 factor 缩.
function alignAiChatToZoom(level: number) {
  if (!aiChatWindow || aiChatWindow.isDestroyed()) return;
  const { width: w, height: h, minWidth, minHeight } = getAiChatSize(level);
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  aiChatWindow.setMinimumSize(minWidth, minHeight);
  aiChatWindow.setBounds({
    x: Math.round(screenWidth / 2 - w / 2),
    y: Math.round(screenHeight * 0.15),
    width: w,
    height: h,
  });
  applyZoomToWebContents(aiChatWindow.webContents, level / 100);
}
ipcMain.on('sync-zoom', (_event, level: number) => {
  if (!level || level < 75 || level > 200) return;
  currentZoomLevel = level;
  if (mainWindow && !mainWindow.isDestroyed()) {
    applyZoomToWebContents(mainWindow.webContents, level / 100);
    applyMainWindowZoomSize(level);
  }
  alignCaptureToZoom(level);
  alignAiChatToZoom(level);
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
  // float 持久窗口: 切主题跟 Capture/AiChat 一样销毁, 下次触发用新主题重建 (防 hidden 窗口 GPU paint cache 残旧主题)
  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.destroy();
    floatWindow = null;
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

// 从主窗口 localStorage 同步用户显示比例,创建 Capture 前调用
async function ensureCurrentZoomLevel() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const s = await mainWindow.webContents.executeJavaScript(
      `localStorage.getItem('quink_zoom_level')`
    );
    const n = Number(s);
    if (n && n >= 75 && n <= 200) currentZoomLevel = n;
  } catch {}
}

// Capture 窗口尺寸按 zoom 比例缩放: 650×155 是默认 100% 时的基准。
// 宽度也得跟着缩,否则 150% 时 toolbar 按钮宽超过窗口宽 → 工具栏换行。
// 75 → 487×116, 100 → 650×155, 150 → 975×232。
function getCaptureSize(zoomLevel: number): { width: number; height: number } {
  const factor = zoomLevel / 100;
  return { width: Math.round(650 * factor), height: Math.round(155 * factor) };
}

// AiChat 窗口尺寸按 zoom 比例缩放: 480×560 是默认 100% 基准, minWidth/minHeight 400 同样缩放.
// 跟 Capture 不同: AiChat 仍可 resize (不锁 max), 但每次 sync-zoom 都 setBounds 按基准 × factor 重置,
// 用户上次拖动的自定义尺寸会被覆盖. trade-off: 接受这个为了 zoom 联动窗口
function getAiChatSize(zoomLevel: number): { width: number; height: number; minWidth: number; minHeight: number } {
  const factor = zoomLevel / 100;
  return {
    width: Math.round(480 * factor),
    height: Math.round(560 * factor),
    minWidth: Math.round(400 * factor),
    minHeight: Math.round(400 * factor),
  };
}

// 选中文字悬浮窗尺寸按 zoom 比例缩放: 320×54 是默认 100% 基准 (胶囊内容 300×34 + 四周 10px 投影留白, 见 FloatingMenu.vue)。
// 跟 Capture 一样窗口物理尺寸 × factor + did-finish-load 后 setZoomFactor, 否则内容继承 origin zoom level 被放大却裁切。
function getFloatSize(zoomLevel: number): { width: number; height: number } {
  const factor = zoomLevel / 100;
  // Windows: 窗口 200×34 (3 按钮, Win11 系统圆角 + 系统投影, 无 CSS 投影留白);
  // Mac: 220×54 (含四周 10px 投影留白, transparent + CSS 投影)
  if (process.platform === 'win32') {
    return { width: Math.round(200 * factor), height: Math.round(34 * factor) };
  }
  return { width: Math.round(220 * factor), height: Math.round(54 * factor) };
}

// 翻译结果窗口尺寸按 zoom 比例缩放: 640×420 是默认 100% 基准, min 跟着缩. 可 resize (读长文).
function getTranslateSize(zoomLevel: number): { width: number; height: number; minWidth: number; minHeight: number } {
  const factor = zoomLevel / 100;
  return {
    width: Math.round(640 * factor),
    height: Math.round(420 * factor),
    minWidth: Math.round(420 * factor),
    minHeight: Math.round(260 * factor),
  };
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

app.whenReady().then(async () => {
  // 读"连哪个 server"配置. 首次启动 (无配置) → 弹引导页不走主流程; 用户选完写 config + relaunch 重新进这里.
  const cfg = readServerConfig();
  if (!cfg) {
    createSetupWindow(true);
    return;
  }
  applyServerConfig(cfg);

  // remote: 不拉内嵌 server, 先确认远程可达 (连不上弹 dialog 重试/换服务器/退出).
  // local: 按"对局域网开放"决定 host 拉起内嵌 server (打包后才真 spawn, dev 由 pnpm dev:server 跑).
  if (cfg.mode === 'remote') {
    const { ok } = await checkRemote(cfg.remoteUrl);
    if (!ok) {
      await handleRemoteUnreachable(cfg.remoteUrl);
      return; // 当前启动到此为止, 由 relaunch / 引导接管
    }
  } else {
    await startServer(cfg.localExposeLan ? '0.0.0.0' : '127.0.0.1', cfg.localPort);
  }

  // 加载持久化的附件传输任务历史 (跨 session 恢复 success/failed 终态)
  attachmentTasksStore.load();
  // 注册全局下载处理: Electron 默认 <a download> / video controls 下载会直接存到 ~/Downloads,
  // 不弹"另存为"对话框. 直接 setSavePath 到 currentDownloadDir (设置里指定目录, 不弹窗).
  // currentDownloadDir 由 renderer 端启动时 IPC sync-download-path 推过来 (localStorage 配置), 默认 ~/Downloads
  session.defaultSession.on('will-download', (_event, item) => {
    const targetDir = currentDownloadDir;
    // 重名时加序号: foo.txt → foo (1).txt → foo (2).txt
    const originalName = item.getFilename();
    let savePath = path.join(targetDir, originalName);
    if (fs.existsSync(savePath)) {
      const ext = path.extname(originalName);
      const base = path.basename(originalName, ext);
      let i = 1;
      while (fs.existsSync(path.join(targetDir, `${base} (${i})${ext}`))) i++;
      savePath = path.join(targetDir, `${base} (${i})${ext}`);
    }
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
    item.setSavePath(savePath);
    // 跟 attachmentTasksStore 关联让 dock 显示进度. url 跟 web 端 addDownloadTask 传的一致 (item.getURL() = absolute URL)
    const url = item.getURL();
    attachmentTasksStore.markSavePathByUrl(url, savePath);
    item.on('updated', (_e, state) => {
      if (state === 'progressing' && !item.isPaused()) {
        attachmentTasksStore.updateProgressByUrl(url, item.getReceivedBytes(), item.getTotalBytes());
      }
    });
    item.on('done', (_e, state) => {
      if (state === 'completed') {
        attachmentTasksStore.markSuccessByUrl(url);
      } else if (state === 'interrupted') {
        attachmentTasksStore.markFailedByUrl(url, '下载中断');
      } else if (state === 'cancelled') {
        attachmentTasksStore.removeByUrl(url);
      }
    });
  });

  // 必须在 createMainWindow / createTray 之前,这俩都用 currentTheme 决定图标
  currentTheme = readCachedTheme();
  createMainWindow();
  // 不在启动时预创建 captureWindow：那时 currentTheme 还是默认值（mainWindow 还没 fetchMe），
  // 预创建会让窗口 backgroundColor 用错误主题，导致首次按快捷键时 OS 显示几帧"上次主题色"
  // 等用户首次按 Shift+Space 时再创建，那时 currentTheme 已经被 sync-theme IPC 更新到正确值
  createTray();

  // 启动底层键盘钩子并注册默认快捷键. Mac 没辅助功能权限时 startHook 返 false → 引导授权
  const hookOk = startHook();
  applyShortcuts();
  if (!hookOk) promptAccessibilityPermission();

  // 全局选中悬浮窗：快捷键触发
  tryInitSelectionGrabber();

  console.log('Quink Desktop is running.');
});

// Mac Cmd+Q / 菜单退出 → before-quit, 设 isQuitting 让 mainWindow close 不再 preventDefault+hide → 真退出.
// (Windows 退出走托盘"退出"已先设 isQuitting, 这里幂等; before-quit 只在用户真要退时触发, 不破坏关到托盘)
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  stopHook();
  tryStopSelectionMonitor();
  stopServer(); // 关掉内嵌 server 进程
  // 显式销毁托盘，避免某些 Windows 环境下应用退出后图标残留
  if (tray && !tray.isDestroyed()) tray.destroy();
});

// ──────────────────────────────────
//  AI 对话快捷窗口
// ──────────────────────────────────
function createAiChatWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const { width, height, minWidth, minHeight } = getAiChatSize(currentZoomLevel);

  aiChatWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(screenWidth / 2 - width / 2),
    y: Math.round(screenHeight * 0.15),
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: false,
    backgroundColor: THEME_BG[currentTheme] || '#ffffff',
    roundedCorners: true,
    minWidth,
    minHeight,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  aiChatWindow.loadURL(`${WEB_URL}/ai-chat`);
  hookZoomChanged(aiChatWindow);
  // 同 createCaptureWindow: did-finish-load 后显式 setZoomFactor, 防新窗口 factor 默认 1.0 跟物理不匹配
  aiChatWindow.webContents.once('did-finish-load', () => {
    if (!aiChatWindow || aiChatWindow.isDestroyed()) return;
    applyZoomToWebContents(aiChatWindow.webContents, currentZoomLevel / 100);
  });

  aiChatWindow.on('closed', () => { aiChatWindow = null; });
}

// ──────────────────────────────────
//  翻译结果窗口 (划词翻译, 左右对照)
// ──────────────────────────────────
function createTranslateWindow(original: string, translated: string, lang: string) {
  // 每次新建, 关掉上一个 (翻译结果一次性; 上次 hideWindow 只 hide 未销毁, 在这里 close 掉)
  if (translateWindow && !translateWindow.isDestroyed()) {
    translateWindow.close();
    translateWindow = null;
  }

  // 居中鼠标所在显示器
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const { width, height, minWidth, minHeight } = getTranslateSize(currentZoomLevel);
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + (area.height - height) / 2);

  translateWindow = new BrowserWindow({
    width, height, x, y, minWidth, minHeight,
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

  const o = encodeURIComponent(original.slice(0, 5000));
  const t = encodeURIComponent(translated.slice(0, 5000));
  const l = encodeURIComponent(lang || '');
  translateWindow.loadURL(`${WEB_URL}/translate-result?o=${o}&t=${t}&lang=${l}`);
  hookZoomChanged(translateWindow);
  // did-finish-load 后显式 setZoomFactor, 防新窗口 factor 默认 1.0 跟物理不匹配 (同 AiChat/Capture)
  translateWindow.webContents.once('did-finish-load', () => {
    if (!translateWindow || translateWindow.isDestroyed()) return;
    applyZoomToWebContents(translateWindow.webContents, currentZoomLevel / 100);
  });
  translateWindow.once('ready-to-show', () => {
    translateWindow?.show();
    translateWindow?.focus();
  });
  translateWindow.on('closed', () => { translateWindow = null; });
}

// float 拿到译文后触发: 弹独立对照窗口. 同步主题 + 显示比例 (float 发起时主窗口可能刚改过),
// 保证 backgroundColor + 尺寸 + zoom 用最新值
ipcMain.on('open-translate-result', async (_event, payload: { original: string; translated: string; lang: string }) => {
  await ensureCurrentTheme();
  await ensureCurrentZoomLevel();
  createTranslateWindow(payload?.original || '', payload?.translated || '', payload?.lang || '中文');
});

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
    // 同 captureWindow 双层 align: show 前优化 + once('show') 兜底 (hide 期间 OS 可能延迟 setBounds / setZoomFactor)
    alignAiChatToZoom(currentZoomLevel);
    aiChatWindow.once('show', () => alignAiChatToZoom(currentZoomLevel));
    aiChatWindow.show();
    aiChatWindow.focus();
    // 跟 captureWindow 一致: 通知 renderer 重新 DOM focus 输入框. Windows 上单纯 BrowserWindow.focus()
    // 对 hidden→show 窗口经常被 SetForegroundWindow 限制 (foreground lock) 静默失败, 必须紧跟 webContents
    // 内 DOM 元素 .focus() 让 Chromium 重新激活 hwnd, 焦点才会从原窗口真切到这里
    aiChatWindow.webContents.send('window-shown');
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

// Mac 点 Dock 图标 → 恢复主窗口. main 窗口 close 走 hide(不退出), Mac 没任务栏, 靠 Dock activate 唤回.
// (activate 只在 macOS 触发, Windows 无 Dock 不受影响)
app.on('activate', () => {
  showMainWindow();
});

// ──────────────────────────────────
//  全局悬浮窗（选中文字后弹出）
// ──────────────────────────────────

async function showFloatWindow(text: string) {
  if (!authToken) { console.log('[Float] no auth token, skip'); return; }
  lastFloatText = text; // 缓存当前文字 (占位; 后台读到选中后由 updateFloatText 覆盖)

  await ensureCurrentZoomLevel();

  // 位置: 直接用 Electron 的鼠标坐标 (本来就是 DIP, 无物理/DIP 转换问题), float 中心对齐鼠标.
  // 不用 native 传的选中文字坐标 — 那是 GetCursorPos 物理像素, 系统缩放≠100% 时窗口位置会偏
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const { width: winW, height: winH } = getFloatSize(currentZoomLevel);
  // 窗口左上角 = 鼠标 - 半个窗口 → float 正中对准鼠标, 下面 px/py 再夹到工作区内防出屏
  const anchorX = cursor.x - Math.round(winW / 2), anchorY = cursor.y - Math.round(winH / 2);
  const px = Math.round(Math.max(area.x, Math.min(anchorX, area.x + area.width - winW - 10)));
  const py = Math.round(Math.max(area.y, Math.min(anchorY, area.y + area.height - winH - 10)));

  // 持久窗口: 已存在直接复用 (挪到鼠标新位置 + IPC 传新选中文字 + show), 不销毁重建 → 秒开
  if (floatWindow && !floatWindow.isDestroyed()) {
    floatWindow.setBounds({ x: px, y: py, width: winW, height: winH });
    applyZoomToWebContents(floatWindow.webContents, currentZoomLevel / 100);
    floatWindow.webContents.send('float-text', text.slice(0, 2000));
    floatWindow.show();
    floatWindow.focus();
    floatWindow.webContents.send('window-shown');
    return;
  }

  // 首次创建 (懒加载, 之后持久 hide/show, 秒开)
  await ensureCurrentTheme();
  const isWin = process.platform === 'win32';
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
    // Windows: 实色背景避开"透明+置顶窗口失焦"的 inactive caption; roundedCorners 用 Win11 自带系统圆角.
    // 背景用侧边栏色 → 整窗一块 sidebar 色, float-bar 撑满同色不露底. Mac: 保持 transparent 药丸 + CSS 投影
    transparent: !isWin,
    backgroundColor: isWin ? (THEME_SIDEBAR[currentTheme] || '#ffffff') : '#00000000',
    roundedCorners: true, // Win11 给无边框窗口上系统圆角 (放弃 native 裁药丸: 裁药丸四角会露半透明边框)
    hasShadow: isWin, // Win11 圆角矩形的系统投影跟随圆角, 不再露角
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hookZoomChanged(floatWindow);

  const encodedText = encodeURIComponent(text.slice(0, 2000));
  floatWindow.loadURL(`${WEB_URL}/float?text=${encodedText}`);

  // 内容缩放对齐窗口物理尺寸: 清 origin 残留 zoom level + setZoomFactor(factor). did-finish-load 而非
  // dom-ready — 后者 setZoomFactor 可能被 navigation 完成时 reset (跟 Capture/AiChat 一致)
  floatWindow.webContents.once('did-finish-load', () => {
    if (floatWindow && !floatWindow.isDestroyed()) {
      applyZoomToWebContents(floatWindow.webContents, currentZoomLevel / 100);
      // 首次创建期间后台可能刚读到选中, 渲染器 listener 就绪后补发一次最新文字 (防首开竞态丢字)
      floatWindow.webContents.send('float-text', lastFloatText.slice(0, 2000));
    }
  });

  floatWindow.once('ready-to-show', () => {
    floatWindow?.show();
    floatWindow?.focus();
  });

  // 失焦自动隐藏 (去 transparent 后 hide 不再触发那条 caption). 80ms 防抖: 躲过 focus 抖动又不显拖沓
  floatWindow.on('blur', () => {
    setTimeout(() => {
      if (floatWindow && !floatWindow.isDestroyed() && !floatWindow.isFocused()) {
        floatWindow.hide();
      }
    }, 80);
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
      // Ctrl+C 兜底读到的选中 → 更新到已弹出的 float (窗口已在 triggerFloatWindow 里先弹好)
      if (event.text && event.text.trim()) {
        updateFloatText(event.text.trim());
      }
    });
  } catch {
    console.log('Native module not available.');
  }

  console.log('Selection grabber ready.');
}

function tryStopSelectionMonitor() {}
