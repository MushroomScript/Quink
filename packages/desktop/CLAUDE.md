# packages/desktop/CLAUDE.md

Electron 主进程 + preload 相关坑。该目录的代码主要写 `main.ts`（窗口/快捷键/IPC/托盘）和 `preload.ts`（暴露给 webContents 的安全 API）。

跨包改动：`packages/web/index.html` / `Capture.vue` / `AiChat.vue` / `RichEditor.vue` 也是这套快捷窗口机制的一部分，改这些文件前先回到本文件确认契约（特别是 IPC 名字、`@ready` 事件）。

## Electron 快捷窗口（Capture / AiChat）

### Win11 OS 窗口动画的触发条件
默认所有标准 `BrowserWindow` 在 Win11 上有 fade in/out + 微缩放的窗口动画（OS 级别免费送）。两种情况 OS 会**跳过整个生命周期的动画**（包括关闭）：
- 调用过 `setOpacity()`：OS 判定 opacity 由应用自管，不再做动画
- `backgroundColor: '#00000000'`（alpha=0）：OS 视为非常规窗口

**结论**：要 OS 自带动画就**不要调用 `setOpacity()`**，背景色用纯色（推荐跟主题走，见下文）。

### 快捷窗口主题闪烁的 4 层防御
打开快捷窗口时的"白闪 / 旧主题色闪"有 4 个独立来源，每层都要做防御：

1. **Electron 窗口 `backgroundColor`**（OS 显示窗口边缘的填充色，在 webContents paint 之前可见几帧）
   - `THEME_BG[currentTheme]` 映射（main.ts，跟 style.css 的 `--c-body` 一致）
   - `sync-theme` IPC 时调 `setBackgroundColor(...)` 更新已存在窗口（影响下次 paint）

2. **HTML body 背景**（CSS 加载之前浏览器用默认白色 paint）
   - `packages/web/index.html` 第一个 inline script 同步设 `<html>` 的 inline `background`，不依赖 CSS 加载

3. **webContents GPU paint cache**（hidden 窗口 Chromium 不 repaint，切主题后 cache 仍是旧主题）
   - `sync-theme` IPC 时**销毁** captureWindow/aiChatWindow，下次按快捷键重建。新窗口直接用新主题色创建，无 cache 残留
   - 同主题下仍是持久窗口（hide/show），保留响应速度

4. **Vditor 等异步组件加载导致的布局跳变**（`after` callback 触发前 `.vditor-wrapper` 是空 div，下面工具栏贴顶部）
   - `RichEditor` 暴露 `@ready` 事件（Vditor `after` callback 内 emit）
   - Capture.vue 收到 ready → 调 `quink.notifyContentReady()` (preload) → IPC `'content-ready'`
   - 主进程 `ipcMain.once('content-ready', show)` 之前不 show 窗口（带 3 秒超时兜底）
   - 代价：首次按快捷键等 ~300ms（Vditor 加载），但出现时整个界面已完整布局
   - 另外给 `.vditor-wrapper` 设 `min-height: (minHeight + 36) + 'px'` 兜底占位（万一 ready 信号没发，至少占位不塌缩）

### 启动时机：不要在 `app.whenReady` 预创建快捷窗口
**坑**：`app.whenReady` 里立即 `createCaptureWindow()`（为了加快首次响应）→ 但那时主窗口还没 fetchMe，`currentTheme` 还是默认 `'blueberry'` → captureWindow 用错误主题色创建 → 首次按快捷键时背景闪 "blueberry 色"几帧。

**正解**：**懒加载**。`toggleCaptureWindow` 在 `captureWindow` 不存在时才创建。那时主窗口已经 sync-theme IPC 把 `currentTheme` 设到用户实际主题，新窗口直接用对的颜色。代价：首次按快捷键多等 ~300ms，跟切换主题后第一次打开体验一致。

### `currentTheme` 主进程缓存机制（3 个同步源）
- `let currentTheme = 'blueberry'` 默认值
- `loadUserShortcuts`：启动时从 server preferences 同步（异步，可能晚）
- `sync-theme` IPC：用户切主题时 web 端调 `quinkDesktop.syncTheme()` → 更新 `currentTheme` + `setBackgroundColor` + destroy 快捷窗口
- `ensureCurrentTheme()`：创建快捷窗口前从主窗口 localStorage **主动**读最新值（防 race，确保 backgroundColor 不会用过期值）

### 持久窗口 vs 销毁重建的混合策略
- **同主题下**：持久窗口 `hide()` / `show()` 切换，响应 < 10ms
- **切换主题时**：sync-theme IPC 触发 `destroy()` 销毁快捷窗口；下次按快捷键走完整 create → ensureCurrentTheme → 等 content-ready → show 路径 (~300ms)，用新主题完整渲染
- 平衡了**速度**（同主题下快）和**正确性**（切换后不闪）

### BrowserWindow 边界是 OS 级硬限制 — DOM 无法溢出
Electron `BrowserWindow` 是一个独立 OS 窗口，宽高就是它的物理边界。**任何 DOM 元素都无法溢出**，包括 `position: fixed` + 高 z-index 也不行 —— fixed 只是相对 viewport（= window 客户区），window 边界外的部分会被操作系统直接裁掉。

这跟浏览器里"右键菜单可以飞到地址栏外"不一样：那是 OS 渲染的弹出窗口，不是 DOM。微信 PC 端等能让 tooltip / 弹出菜单溢出主窗口，是因为它们用 OS 原生 popup（Win32 `CreateWindowEx` 创建独立小窗口），不是 DOM。

**对 Capture / AiChat 这类小窗口的影响**：tooltip / popover / dropdown 等浮层元素要保证完整可见，必须在 window 内自适应位置：
- tooltip 默认朝上、上方空间不够时翻转朝下（`r.top < threshold` 检测）
- tooltip 左右居中、超出窗口边界时 `clamp(left, MARGIN+HALF, vw-MARGIN-HALF)`
- 范例：`RichEditor.vue` 的 `onToolbarMouseOver` 实现

**如果真的需要让 popup 溢出 Capture 窗口**：唯一方法是新建一个无边框 + 透明 + alwaysOnTop 的 BrowserWindow 当 popup 用，每次 hover 时创建 / setPosition / show / hide。工作量大（~100 行 IPC + 窗口管理），不建议为单个 tooltip 这么做。

## IPC 契约

| 通道名 | 方向 | 用途 |
|---|---|---|
| `save-note` | renderer → main (invoke) | 保存笔记（快捷记录用） |
| `hide-window` | renderer → main (send) | renderer 主动让 main 隐藏当前窗口 |
| `note-saved` | renderer → main (send) | 通知 main 显示"已保存" toast |
| `content-ready` | renderer → main (send) | Vditor 等异步组件加载完，main 才 show 窗口 |
| `sync-theme` | renderer → main (send) | 主窗口切主题时通知 main，main 销毁快捷窗口 + 更新缓存 |
| `sync-font-size` | renderer → main (send) | 主窗口改字体时通知 main，main 调整 Capture 窗口尺寸 + 转发到快捷窗口 |
| `sync-download-path` | renderer → main (send) | 设置页改下载目录时把路径推给 main，will-download 用 `currentDownloadDir` 直接 setSavePath（不弹对话框） |
| `pick-directory` | renderer → main (invoke) | 设置页选下载目录时调，main 弹 `dialog.showOpenDialog({properties:['openDirectory','createDirectory']})`，返回路径或 null |
| `get-default-download-dir` | renderer → main (invoke) | 设置页显示"系统默认"路径时调，main 返回 `app.getPath('downloads')` 的真实绝对路径 |
| `reload-shortcuts` | renderer → main (send) | 用户修改快捷键后重新注册 |
| `window-shown` | main → renderer (send) | 通知 renderer 窗口刚显示（用于聚焦输入框、同步主题等） |
| `window-hidden` | main → renderer (send) | 通知 renderer 窗口被隐藏 |
| `font-size-changed` | main → renderer (send) | 通知 Capture / AiChat renderer 更新 document fontSize（用户在主窗口改了字体） |
| `open-attachment` | renderer → main (invoke) | 用系统默认应用打开附件 URL（fetch 到 OS 临时目录 → `shell.openPath`）。原因：直接让浏览器跟随 `<a href="/api/uploads/xxx.md">` 跳走时，Electron 内嵌 chromium 对 `text/markdown` 等 mime 显示空白页 |
| `cancel-attachment` | renderer → main (invoke) | 取消正在下载的附件。main 端在 `attachmentControllers: Map<url, AbortController>` 找到对应 controller 调 `abort()`，被取消的 `open-attachment` 走 catch 分支返回 `{ success: false, cancelled: true }`（区别于停滞超时 → `{ success: false, error: '下载停滞...' }`）。renderer 据此决定是否弹 toast（cancelled 不弹） |
| `pdf-thumb-cache:get` | renderer → main (invoke) | 查 PDF 首页缩略图持久化缓存。返回 `Buffer` 或 `null`。目录 `userData/pdf-thumb-cache/<basename(url)>.jpg` |
| `video-thumb-cache:get` | renderer → main (invoke) | 查视频首帧缩略图持久化缓存。返回 `Buffer` 或 `null`。目录 `userData/video-thumb-cache/<basename(url)>.jpg` |
| `video-thumb-cache:put` | renderer → main (invoke) | 写视频首帧 jpeg 到磁盘缓存。参数 `(url, ArrayBuffer)`，返回 `boolean` |
| `pdf-thumb-cache:put` | renderer → main (invoke) | 写 PDF 缩略图 jpeg 到磁盘缓存。参数 `(url, ArrayBuffer)`，返回 `boolean` |

## chrome-devtools-mcp 调试 Electron

Electron 启动时加 `--remote-debugging-port=9222`，Chrome DevTools Protocol 暴露在 `http://127.0.0.1:9222`。配合 `chrome-devtools-mcp` MCP server 可以让 Claude 直接操作 Electron 内的页面（evaluate_script / click / press_key / take_screenshot / 注入 MutationObserver 等）。

**启动配置**：
- `start-desktop.bat` 第 66 行的 electron 命令带 `--remote-debugging-port=9222`
- `packages/desktop/package.json` 的 `dev` 脚本也带（备用，给走 `pnpm run dev:desktop` 的场景）

**典型用途**：肉眼录屏看不清的视觉/layout 闪烁 bug（毫秒级 setAttribute / childList 变化）。流程是 evaluate_script 注入 MutationObserver 到目标元素 + 父级容器全树 → 触发动作 → 读 mutation log，精确到 1ms 看哪个元素什么属性被改了。范例：定位 `NoteEditModal` 关闭闪烁 root cause（vditor.destroy 在 leave 动画期间 3ms 内就触发完成）。详见 `RENDERING-PITFALLS.md` "动画" 段的对应坑。

改 IPC 时三处都要同步：`main.ts` 的 `ipcMain.on/once`、`preload.ts` 的 `exposeInMainWorld`、web 端调用 `(window as any).quink?.xxx`。
