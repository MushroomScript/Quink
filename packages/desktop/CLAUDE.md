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

## IPC 契约

| 通道名 | 方向 | 用途 |
|---|---|---|
| `save-note` | renderer → main (invoke) | 保存笔记（快捷记录用） |
| `hide-window` | renderer → main (send) | renderer 主动让 main 隐藏当前窗口 |
| `note-saved` | renderer → main (send) | 通知 main 显示"已保存" toast |
| `content-ready` | renderer → main (send) | Vditor 等异步组件加载完，main 才 show 窗口 |
| `sync-theme` | renderer → main (send) | 主窗口切主题时通知 main，main 销毁快捷窗口 + 更新缓存 |
| `reload-shortcuts` | renderer → main (send) | 用户修改快捷键后重新注册 |
| `window-shown` | main → renderer (send) | 通知 renderer 窗口刚显示（用于聚焦输入框、同步主题等） |
| `window-hidden` | main → renderer (send) | 通知 renderer 窗口被隐藏 |

改 IPC 时三处都要同步：`main.ts` 的 `ipcMain.on/once`、`preload.ts` 的 `exposeInMainWorld`、web 端调用 `(window as any).quink?.xxx`。
