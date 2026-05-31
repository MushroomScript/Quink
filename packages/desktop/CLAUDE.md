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
| `note-saved` | renderer → main (send) | 通知 main 显示"已保存" toast + 转发 `quink-note-created` 给主窗口 (可选带 `noteId` 让主窗口走单条 AI 结果轮询 patch, 不带回退全量 fetchNotes) |
| `content-ready` | renderer → main (send) | Vditor 等异步组件加载完，main 才 show 窗口 |
| `sync-theme` | renderer → main (send) | 主窗口切主题时通知 main，main 销毁快捷窗口 + 更新缓存 |
| `sync-zoom` | renderer → main (send) | 主窗口改"显示比例"时通知 main，main 给 3 个窗口（main / Capture / AiChat）setZoomLevel(0)+setZoomFactor + 调整 Capture/AiChat 物理尺寸。详见下方"全局显示比例（zoom）"段 |
| `zoom-step` | main → renderer (send to mainWindow) | 快捷窗口里 Ctrl+滚轮 触发 main 端 webContents 'zoom-changed' 拦截后，转发 ±100 deltaY 给主窗口走完整 stepZoom 路径 |
| `sync-download-path` | renderer → main (send) | 设置页改下载目录时把路径推给 main，will-download 用 `currentDownloadDir` 直接 setSavePath（不弹对话框） |
| `pick-directory` | renderer → main (invoke) | 设置页选下载目录时调，main 弹 `dialog.showOpenDialog({properties:['openDirectory','createDirectory']})`，返回路径或 null |
| `get-default-download-dir` | renderer → main (invoke) | 设置页显示"系统默认"路径时调，main 返回 `app.getPath('downloads')` 的真实绝对路径 |
| `reload-shortcuts` | renderer → main (send) | 用户修改快捷键后重新注册 |
| `window-shown` | main → renderer (send) | 通知 renderer 窗口刚显示（用于聚焦输入框、同步主题等） |
| `window-hidden` | main → renderer (send) | 通知 renderer 窗口被隐藏 |
| `open-attachment` | renderer → main (invoke) | 用系统默认应用打开附件 URL（fetch 到 OS 临时目录 → `shell.openPath`）。原因：直接让浏览器跟随 `<a href="/api/uploads/xxx.md">` 跳走时，Electron 内嵌 chromium 对 `text/markdown` 等 mime 显示空白页 |
| `cancel-attachment` | renderer → main (invoke) | 取消正在下载的附件。main 端在 `attachmentControllers: Map<url, AbortController>` 找到对应 controller 调 `abort()`，被取消的 `open-attachment` 走 catch 分支返回 `{ success: false, cancelled: true }`（区别于停滞超时 → `{ success: false, error: '下载停滞...' }`）。renderer 据此决定是否弹 toast（cancelled 不弹） |
| `pdf-thumb-cache:get` | renderer → main (invoke) | 查 PDF 首页缩略图持久化缓存。返回 `Buffer` 或 `null`。目录 `userData/pdf-thumb-cache/<basename(url)>.jpg` |
| `video-thumb-cache:get` | renderer → main (invoke) | 查视频首帧缩略图持久化缓存。返回 `Buffer` 或 `null`。目录 `userData/video-thumb-cache/<basename(url)>.jpg` |
| `video-thumb-cache:put` | renderer → main (invoke) | 写视频首帧 jpeg 到磁盘缓存。参数 `(url, ArrayBuffer)`，返回 `boolean` |
| `pdf-thumb-cache:put` | renderer → main (invoke) | 写 PDF 缩略图 jpeg 到磁盘缓存。参数 `(url, ArrayBuffer)`，返回 `boolean` |
| `attachment-tasks:get` | renderer → main (invoke) | 拉取全量传输任务列表（启动时同步用）。返回 `PersistedTask[]` |
| `attachment-tasks:add` | renderer → main (invoke) | 新增 task。main 端 `attachmentTasksStore.add` 内部对同 URL download 复用同条 (重置为 downloading)，返回实际使用的 id (可能跟入参不同) |
| `attachment-tasks:update-progress` | renderer → main (send) | 推上传进度 `{id, received, total}`。main 端 store 不 persist downloading 状态，只 broadcast `attachment-tasks:progress` |
| `attachment-tasks:mark-success` | renderer → main (send) | 标记 task 完成（id 入参）。main 端 persist + broadcast sync |
| `attachment-tasks:mark-failed` | renderer → main (send) | 标记 task 失败 `{id, error}` |
| `attachment-tasks:remove` | renderer → main (send) | 从列表移除（dismiss / cancelled 共用） |
| `attachment-tasks:cancel` | renderer → main (send) | 取消进行中任务。main 端 download 走 abort fetch；upload broadcast `attachment-tasks:abort-uploads` 让发起 renderer 端 abort 本地 controller |
| `attachment-tasks:clear-completed` | renderer → main (send) | 清空所有 success/failed/cancelled 任务，保留 downloading |
| `attachment-tasks:close` | renderer → main (send) | 强力关闭：abort 所有 inflight + 清空列表 + broadcast |
| `attachment-tasks:sync` | main → renderer (send) | 全量推送 task 列表 (add / mark / remove / clear / close 后触发)。所有 webContents 都收到 |
| `attachment-tasks:progress` | main → renderer (send) | 单条进度推送 `{id, received, total}` (高频，避免每次广播全量) |
| `attachment-tasks:abort-uploads` | main → renderer (send) | cancel / close 时让本地有 upload AbortController 的窗口 abort 本地 xhr/fetch |

## 全局附件传输任务（attachmentTasksStore）

跨 BrowserWindow 共享的 task 状态唯一来源在 main 端 `attachmentTasksStore.ts`，跨 session 持久化到 `userData/attachment-tasks.json`（仅终态 success/failed/cancelled，downloading 不写盘）。最多 50 条历史，超出 LRU 丢最旧。

**why**：主 / Capture / AiChat 是独立 BrowserWindow，各自的 Vue app + module-level ref 不共享；localStorage 也不跨 origin（主窗口 http://localhost:24888 vs Capture/AiChat file://）。所以走 main 端中心化 IPC。

**职责分工**：
- main 端 `attachmentTasksStore`：tasks 数组唯一来源 + persist + broadcast；download 取消由 main 端 abort fetch（`attachmentControllers` Map）
- renderer 端 `useAttachmentTasks`：thin client，`tasks ref` 由 `attachment-tasks:sync` 维护；保留本地 `localAbortControllers` Map 给 upload 用（AbortController 跨进程不能传，main 端不存它）；接口签名（addDownloadTask / markSuccess / cancelTask 等）保持稳定，内部全部 IPC 化

**Web 端 fallback**：浏览器场景 `quinkDesktop.attachmentTasks` 不存在，useAttachmentTasks 走本地 ref + localStorage 路径（保留旧实现），单窗口无共享需求。

**改这套时注意**：
- 改 task 字段结构（PersistedTask 加字段）要同时改 main store / renderer composable / preload 三处
- 进度高频更新走单条 progress 事件（不广播全量），改 add/mark/remove 都广播全量 sync
- AbortController 必须留 renderer（跨进程无法序列化），cancel 走 broadcast 协议而非"main 直接 abort upload"

## 全局显示比例（zoom）

主窗口改"显示比例" → main 端 sync-zoom IPC 给 3 窗口同步缩放（内容 + 物理尺寸）。改 zoom 路径前必读以下 4 个坑。

### 1. `setZoomFactor` 单独用不行，必须 `setZoomLevel(0)` + `setZoomFactor(factor)` 配对

Chromium 给 webContents 维护**per-origin 持久化 zoom level**（Ctrl+滚轮触发的 layout zoom 改的就是它）。`setZoomFactor(1.0)` 是 transient 设置，**被 per-origin level 覆盖**：用户在 Capture 里 Ctrl+滚轮把 origin zoom 改到 1.1，之后 `setZoomFactor(1.0)` 调成功但实际 dpr 仍 1.1。

修法：`main.ts` 的 `applyZoomToWebContents(wc, factor)` helper 先 `wc.setZoomLevel(0)` 清 per-origin 缓存，再 `wc.setZoomFactor(factor)`。**顺序不能反**。所有给 webContents 设 zoom 的地方都走这个 helper。

### 2. 快捷窗口里 Ctrl+滚轮要走 main 端 `webContents.on('zoom-changed')` 拦截，**不能用 renderer wheel hook**

DOM `WheelEvent.preventDefault()` 在 renderer 里**阻止不了 Chromium 内置 layout zoom**（layout zoom 是浏览器内部行为，不经 DOM 默认动作路径）。如果在 Capture/AiChat 用 `window.addEventListener('wheel', ...)` + `preventDefault` 想拦 Ctrl+滚轮，结果是：
- DOM preventDefault 阻止默认 scroll（无效，Ctrl+滚轮本来也不滚）
- Chromium 内置 layout zoom **仍然触发**（factor 变了一档）
- renderer hook 转发 IPC → main → 又设一次 zoom
- **内容缩放两次 / 物理窗口缩放一次** → 视觉错位

正确做法：`main.ts` 的 `hookZoomChanged(win)` 监听 `win.webContents.on('zoom-changed', (e, direction) => { e.preventDefault(); ... })`。**这个 `e.preventDefault()` 是 Electron event，能真正阻 Chromium 内置 zoom**。然后转发 `zoom-step` 事件给主窗口走完整 `stepZoom` 链路。

createCaptureWindow / createAiChatWindow 都调一次 `hookZoomChanged(win)`。

### 3. AiChat zoom 联动尺寸跟 Capture 一样（但保留 resize）

Capture：minWidth=maxWidth=getCaptureSize(zoomLevel) 锁死尺寸。
AiChat：minWidth=minHeight=getAiChatSize(zoomLevel) 只锁最小（用户仍可拖大），sync-zoom 时按基准 × factor 重置 bounds 覆盖用户拖动的自定义尺寸。

`createAiChatWindow` 用 `getAiChatSize(currentZoomLevel)` 算初始尺寸 + 居中位置按当前 zoom factor 算。

### 4. App.vue 在 Capture/AiChat 窗口也会 mount，wheel hook 必须 guard

Quink web 是 SPA，App.vue 是根组件挂 `#app`。**所有 BrowserWindow 都加载同一个 SPA**，App.vue 在主窗口 / Capture / AiChat 各 mount 一份（独立 webContents → 独立 Vue app 实例）。

主窗口的 App.vue `onMounted` 注册的 Ctrl+滚轮 hook 也会在 Capture/AiChat 的 App.vue 实例里跑。结果是快捷窗口的 Ctrl+滚轮触发**两次** stepZoom（Capture 自己的 App.vue + main 转发到主窗口的 App.vue），双触发跳两档。

修法：App.vue `onMounted` 的 wheel hook + `onZoomStep` listener 都包 `if (!isShortcutWindow)` —— 用 `location.pathname` 判断（`route.name` 在 mount 时机不可靠）。当前判 `['/capture', '/ai-chat', '/float']` 不算主窗口。

### 5. 主窗口物理尺寸跟 zoom 联动 + 鼠标锚点，防 sidebar 收起 / toolbar 换行 / 留白

主窗口 `setZoomFactor` 后 viewport CSS px = 物理 px / factor。200% zoom 时 1280 物理 → **640 CSS px < Tailwind md: breakpoint (768)** → 触发响应式抽屉模式（sidebar 自动收起）；编辑器 toolbar 按 CSS px 换行同理。

修法：`main.ts` 的 `applyMainWindowZoomSize(zoomLevel)` 给 mainWindow `setBounds` + `setMinimumSize` 两段独立逻辑：

**CSS px 基准**：
- `MAIN_MIN_CSS_W = 900`：sidebar (md: breakpoint 768) + 编辑器 toolbar 不被挤
- `minH` = `MAIN_MIN_CSS_W × (screenH / screenW) × MAIN_MIN_H_BONUS`（按屏幕宽高比算 + 1.1 bonus）：16:9 屏 ≈ 557，16:10 屏 ≈ 619。原始按比例算（无 bonus）16:9 屏只有 506，zoom 缩小时 sidebar 分类显示不下，+10% bonus 给分类留几行可见空间

**setBounds（按用户当前窗口缩放，但保证 ≥ MIN_CSS × factor）**：
- 记 `lastMainZoom` 模块级变量（初始 100，每次 sync-zoom 后更新）
- ratio = newFactor / oldFactor
- W = `max(currentBounds.width × ratio, MAIN_MIN_CSS_W × factor)`
- H = `max(currentBounds.height × ratio, MAIN_MIN_CSS_H × factor)`
- 启动时 currentBounds = createMainWindow 设的 1280×860 当首次基准
- 之后用户每次改 zoom 按**当前实际窗口**缩放（用户拖大窗口后改 zoom，按拖大后的尺寸 × ratio）
- cap 到屏幕 95% 防超屏

**鼠标锚点位置（仿浏览器 Ctrl+滚轮）**：
- `screen.getCursorScreenPoint()` 拿全局鼠标坐标
- 鼠标在窗口内时：`x' = cursor.x - (cursor.x - cur.x) × ratio`，`y'` 同理。推导：鼠标相对窗口的物理 px 偏移 dx → 同一 DOM 点缩放后相对新窗口的物理 px 偏移 = dx × ratio（DOM 点 CSS px 不变，物理 px = CSS px × factor）→ 新窗口 x' = cursor.x - dx × ratio 保证鼠标位置不变下面的 DOM 点也不动
- 鼠标不在窗口内（如快捷窗口 Ctrl+滚轮转发的 zoom-step）→ 回退屏幕居中 `x = (screenW - W) / 2`
- cap 到屏幕内 `x = clamp(x, 0, screenW - W)`（锚点可能让窗口跑出屏幕，优先窗口在屏幕里，牺牲一点锚点精度）

**setMinimumSize**：
- minW = MIN_CSS_W × factor，minH = MIN_CSS_H × factor
- cap 到 setBounds 的 W/H 防 OS 冲突（屏幕 95% cap 触发时 W/H 可能 < MIN_CSS × factor，min 不能 > 当前 bounds 否则 Electron 报错）

**trade-off**：zoom 变化时按当前窗口缩放，用户的拖动比例**保留**。但 zoom 100→200 时窗口物理也按 2× 放大（避免"内容大窗口小"），拖大的窗口下 200% 时可能撑满屏被 cap 到 95%。

### 6. zoom 视觉反馈：renderer CSS transform 平滑过渡，不能用 setOpacity 遮蔽

主窗口 `setZoomFactor` 是 instant 但 `setBounds` 走 OS DWM 窗口动画 ~100-200ms，两个 API 不同步导致 viewport CSS px 在 18ms 内**跌一下涨回去**（实测 1191 → 1072 → 1191）触发瀑布流 ResizeObserver 重排 / sidebar 抽屉断点 / TopBar resize 一连串 layout 抖动，肉眼看像"刷新一下"。

修法：renderer 端 `App.vue` 的 `stepZoom` 在 wheel 触发时立即用 CSS `transform: scale(next/current)` 做 80ms 平滑过渡，`transform-origin` 设为鼠标 viewport 坐标（鼠标锚点视觉反馈，跟 main 端 setBounds 鼠标锚点对齐）。transform 是 GPU 合成层 paint scale，会**盖住底下的 layout 抖动**，用户视觉只看到 scale 平滑动画。80ms 后 clear transform（`transition:none` + 强制 reflow 防 clear 自身被动画化反弹），此时 main 端 paint 已对齐目标 scale，视觉一致。

**坑：不能用 `setOpacity(0/1)` 遮蔽中间帧**。早期方案是 main 端 `setOpacity(0)` 包住 `setBounds` + `setZoomFactor`，80ms 后 `setOpacity(1)`。理论上完美遮蔽 layout 抖动，但**蘑菇实测会看到"窗口消失一下又出现"**，80ms 透明对人眼是可感知的。`transform` GPU paint scale 才是真正不可见的盖法。

**快捷窗口 Ctrl+滚轮转发的 zoom-step 没鼠标位置**：renderer 端 `onZoomStep` 用主窗口中心当 transform-origin (`window.innerWidth/2, innerHeight/2`)，main 端 `applyMainWindowZoomSize` 取到的 cursor 也不在主窗口内 → 自动回退居中，两边对齐。

## chrome-devtools-mcp 调试 Electron

Electron 启动时加 `--remote-debugging-port=9222`，Chrome DevTools Protocol 暴露在 `http://127.0.0.1:9222`。配合 `chrome-devtools-mcp` MCP server 可以让 Claude 直接操作 Electron 内的页面（evaluate_script / click / press_key / take_screenshot / 注入 MutationObserver 等）。

**启动配置**：
- `start-desktop.bat` 第 66 行的 electron 命令带 `--remote-debugging-port=9222`
- `packages/desktop/package.json` 的 `dev` 脚本也带（备用，给走 `pnpm run dev:desktop` 的场景）

**典型用途**：肉眼录屏看不清的视觉/layout 闪烁 bug（毫秒级 setAttribute / childList 变化）。流程是 evaluate_script 注入 MutationObserver 到目标元素 + 父级容器全树 → 触发动作 → 读 mutation log，精确到 1ms 看哪个元素什么属性被改了。范例：定位 `NoteEditModal` 关闭闪烁 root cause（vditor.destroy 在 leave 动画期间 3ms 内就触发完成）。详见 `RENDERING-PITFALLS.md` "动画" 段的对应坑。

改 IPC 时三处都要同步：`main.ts` 的 `ipcMain.on/once`、`preload.ts` 的 `exposeInMainWorld`、web 端调用 `(window as any).quink?.xxx`。
