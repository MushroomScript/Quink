# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库工作时提供指引。

## CLAUDE.md 维护规则

> **根 `CLAUDE.md` 只放整个项目都用到的内容**（跨包通用、全局约定、多文件共享的高频经验）。其他属于某个 package / 子目录的内容，**拆到对应 `CLAUDE.md`，根这里留指针即可**。

仓库里有多个分层文件，按以下规则维护，避免根目录膨胀：

- **根 `CLAUDE.md`** —— 跨包通用 / 全局约定 / 多文件共享的高频经验。Claude Code 启动时自动加载
- **`packages/X/CLAUDE.md`** —— 某 package 内部专属（认证 / AI 系统 / 主题 / 移动端等）。Claude 在该 package 工作时自动加载
- **子目录 `CLAUDE.md`** —— 只该子目录或少数关联文件用到的专属内容。Claude 在该目录工作时自动加载
- **同一主题规则数量大、自成体系** → 拆到独立 `CLAUDE.md`（推荐放对应代码目录），根目录留一行指针
- **使用频率低的规则**（如图标系统：写完后改动少）→ 拆到根目录普通 `.md` 文件（**不带 CLAUDE 前缀**），不自动加载，根 `CLAUDE.md` 留指针让 Claude 在需要时主动读。代价是 Claude 需要根 `CLAUDE.md` 的提示才知道去读 → 好处是启动时不占 context

**当前文件清单：**

| 文件 | 内容 | 加载方式 |
|---|---|---|
| 根 `CLAUDE.md`（本文件） | 全局指引、跨包约定、高频规则 | 自动 |
| 根 `ICONS.md` | 图标系统约定 | 手动（改图标时来读） |
| 根 `RENDERING-PITFALLS.md` | 渲染相关坑（DOM/CSS/Vue/HMR/markdown/Vditor/动画/鼠标事件） | 手动（改 UI / markdown / 编辑器 / 列表动画时来读） |
| 根 `THUMBNAILS.md` | 静态图片缩略图体系（sharp 后端生成 / thumb URL helper / 显示约定） | 手动（改头像 / 资源缩略图 / upload.ts sharp / 加新图片显示场景时来读） |
| 根 `Z-INDEX-SCALE.md` | z-index 体系（CSS 变量 scale 总表 / 用法 / 现存 quirks） | 手动（加新弹层 / popup / modal / overlay 时来读） |
| 根 `GROUPS-ROADMAP.md` | 群组共享 6 个 PR 拆分 + 已拍板决策 + 扩展点子（PR #1 已 ship, PR #2-#6 pending） | 手动（做群组任何 PR / 想接群组扩展前来读） |
| 根 `FOLLOWUPS.md` | 集中收录【观察里说过但暂未做】的延期项, 按"进 PR #X" / "待补"分类. **/ship skill 已强制 ship 前后必读 + 同步** | 手动（每次 ship / 选下一个任务前必读 - 看跟当前改动重叠的能不能顺手做） |
| 根 `badge-test.html` | Badge 微调可视化测试页 (双击浏览器打开, 不依赖项目). 两组上下文 (sidebar 头像菜单 / 4 tab) + 12 个特征数字 + 两个方向盘 (红点位置 / 字位置 sub-pixel 微调) + CSS zoom 滑块模拟显示比例. 用于精调 badge size / padding / 字位置等 sub-pixel 视觉效果 | 手动（加新 badge / 红点 / 类似可视化微调需求时来读 - 改下默认值跟标签即可复用） |
| `packages/server/CLAUDE.md` | 后端专属（认证 / 数据库 / 文件上传后端逻辑 / 重命名同步） | 在该 package 工作时自动 |
| `packages/server/src/ai/CLAUDE.md` | AI 系统（多配置 / FC v2 / 自动处理 / `{categories}` 占位 / 弱模型适配 / chat prompt / label 透传） | 在该子目录工作时自动 |
| `packages/web/CLAUDE.md` | 前端专属（主题系统 / 移动端 / Vditor 静态文件 / 笔记类型→view 映射 / 文件 url helper） | 在该 package 工作时自动 |
| `packages/web/CARDDND.md` | 卡片拖放 DnD 协议（dropzone 表 / pointer events / AI 拖入兜底 / audio anchor 例外） | 手动（改 NoteCard / Sidebar / cardDnd / AI 拖入相关时来读） |
| `packages/web/CURSORS.md` | Bibata 鼠标光标 7 主题动态加载（gen-cursors.mjs / loadThemeCursors / specificity 战争 / 改不了的边界） | 手动（改主题色 / 加新 cursor / 项目内写 cursor: pointer 时来读） |
| `packages/web/CROSS-VIEW-NAV.md` | 跨视图筛选跳转（onActivated 派事件 + TopBar 监听三步约定 / mount 顺序依赖） | 手动（加新跳转线 / 改 App.vue 顶层布局时来读） |
| `packages/desktop/CLAUDE.md` | Electron 主进程坑（OS 窗口动画 / 快捷窗口防闪烁 / IPC 契约 / chrome-devtools-mcp 调试） | 在该 package 工作时自动 |
| `packages/web/src/utils/CLAUDE.md` | 卡片列表 leave 动画体系（`cardLeave.ts` + TransitionGroup 多个坑） | 在该子目录工作时自动 |
| `packages/web/src/composables/CLAUDE.md` | 瀑布流 + 无限滚动体系（`useMasonry` + `useInfiniteScroll`） | 在该子目录工作时自动 |

**新增规则时的判断流程：**

1. **多文件高频用 / 跨包通用** → 根 `CLAUDE.md`
2. **某 package 内专属** → 对应 `packages/X/CLAUDE.md`
3. **某子目录专属** → 对应子目录 `CLAUDE.md`
4. **同一主题积累 ~10 行以上** → 考虑独立成 `CLAUDE.md`
5. **写完后改动少 / 低频** → 根目录普通 `.md` 文件，根 `CLAUDE.md` 留指针

## 项目概览

Quink（一念）是一款带 AI 自动打标签、自动分类、写作辅助的个人笔记应用。pnpm monorepo，三个 package：

- **packages/server** —— Hono + SQLite（better-sqlite3）+ Drizzle ORM 后端 API。认证 / AI 系统 / 数据库 / 文件上传后端逻辑详见 `packages/server/CLAUDE.md`
- **packages/web** —— Vue 3 + Vite + TailwindCSS + Vditor（Markdown 编辑器）+ ECharts（统计页环形图）前端。主题 / 移动端 / Vditor 静态文件 / 笔记类型映射 / 文件 url helper 详见 `packages/web/CLAUDE.md`
- **packages/desktop** —— Electron 桌面壳（主窗口加载 web，全局快捷键弹快速记录窗口）。详见 `packages/desktop/CLAUDE.md`

## 开发命令

```bash
# 启动后端（端口 38999，tsx watch，改代码自动重启）
pnpm run dev:server

# 启动前端（端口 24888）
pnpm run dev:web

# 启动桌面端（编译 desktop ts + 起 electron；走 pnpm filter 才能正确解析根目录的 electron）
pnpm run dev:desktop
```

**Windows 一键启动（推荐）：**

- 双击 `start-server.bat` —— 起后端，单独窗口可见日志
- 双击 `start-desktop.bat` —— 检查后端 → 起 Vite（24888，最小化窗口）→ 编译 desktop → 启 Electron

**坑提醒**：不要写 `cd packages/desktop && npx electron .` —— `electron` 被 pnpm hoist 到根 `node_modules`，npx 在子包目录找不到会触发**现下载**（慢/卡）。永远用 `pnpm --filter @quink/desktop` 或根 `pnpm run dev:desktop`。

前端通过 Vite 配置将 `/api` 请求代理到后端。Electron 主窗口加载 `http://localhost:24888`。

## 数据流总览

```
用户 → Vditor（Markdown）→ API（Hono）→ SQLite
                                       → AI（异步：自动标签/分类/摘要）
```

笔记以 **Markdown** 存储（非 HTML）。Vditor 编辑器原生支持 Markdown。NoteCard 通过 `Vditor.md2html()` 渲染 Markdown → HTML。

各模块详情见对应 package 的 CLAUDE.md。

## Claude Code 工具链（MCP + Skill）

本项目已配的工具，做相应任务时优先用：

- **MCP `chrome-devtools`** —— 调试 Quink Electron 桌面端。Electron 启动脚本带 `--remote-debugging-port=9222`（`start-desktop.bat` 第 66 行 + `packages/desktop/package.json` 的 dev 脚本），MCP 通过 `http://127.0.0.1:9222` 接入。**视觉/layout 闪烁 bug 走它 + MutationObserver**，比肉眼录屏精确到毫秒。范例：定位 NoteEditModal 关闭时 vditor.destroy 在 3ms 内提前触发的 root cause。详见 `packages/desktop/CLAUDE.md` "chrome-devtools-mcp 调试 Electron" 段
- **MCP `sqlite`** —— 直接 SQL 查/改 `packages/server/quink.db`。**塞测试数据 / 查后端状态 / 排查数据问题用**，跳过写一次性脚本（之前 list-users.ts / seed-demo-notes.ts 这类全免了）
- **MCP `playwright`** —— E2E 测试 Quink web 端。**单次回归测试用 prompt 触发**（"测一遍 X 流程"），启动新 Chromium 走完整流程 + 断言。**不写持久化测试代码** —— UI 频繁迭代阶段维护成本太高
- **Slash command `/playwright-e2e`**（qaskills 装的，在 `~/.claude/commands/playwright-e2e/`）—— 写 Playwright 测试代码时按业界 best practice（getByRole 选 selector / Page Object Model / auto-waiting / 测试隔离）。**未来真要写持久化测试时用**
- **Slash command `/ship`**（项目级，在 `.claude/skills/ship/SKILL.md`）—— 一组改动完成后的收尾流程：看工作树 → 必要时同步 CLAUDE.md / RENDERING-PITFALLS.md → 写 commit message → stage + commit。蘑菇说 "commit" 等都触发

### Claude 工作约定（严格遵守）

- **能用 MCP 测的 Claude 自己测**，不要让蘑菇手动验证。验证清单上的步骤如果能用 chrome-devtools-mcp（页面 evaluate / 注入 listener / 看 viewport/dpr/CSS）、playwright-mcp、sqlite-mcp 测的，直接执行测，把结果给蘑菇看。只有需要真人视觉判断 / 物理设备操作（OS 拖窗口、按全局快捷键、看 OS 窗口装饰等 MCP 拿不到的）才让蘑菇验证。
- **改完 main.ts / preload.ts 等需要 Electron 重启的代码 Claude 自己重启**，不要让蘑菇手动重启。重启流程：
  1. `taskkill /F /IM electron.exe`（PowerShell `Get-Process electron | Stop-Process -Force` 也行）—— 关旧 Electron 进程
  2. `pnpm --filter @quink/desktop exec tsc` —— 重新编译 desktop ts (dev 脚本只 build 不 watch, 手动 tsc 必要)
  3. `pnpm --filter @quink/desktop exec electron . --remote-debugging-port=9222` 用 Bash `run_in_background: true` 启动新 Electron
  4. 等 ~3s 让 Electron + 主窗口 ready, 再 chrome-devtools-mcp list_pages 验证
- 改完后只让蘑菇做"必须真人介入"的事（按全局快捷键 / 视觉确认 / 拖窗口测物理边界），不要让他做"Claude 本可以测的"事。

## 核心约定（跨包全局）

- 所有 UI 文案使用中文。
- 全局 `<body>` 加 `spellcheck="false"`，杜绝任何红色波浪线。
- 所有输入框颜色用 CSS 主题变量，禁止硬编码 hex（使用 `rgb(var(--c-accent))` 模式）。
- 笔记内容是 Markdown。AI 返回 Markdown。无需 HTML↔MD 转换。
- 笔记软删除（`deleted_at` 字段），30 天后自动彻底清除。
- 端口：后端 38999，前端 24888。配置在 `vite.config.ts` 和 `server/src/index.ts`。

## 变更操作刷新约定（跨包全局）

**核心约定**：任何导致服务器数据变更的操作（创建 / 修改 / 删除 / 状态切换 等），**操作发起方必须负责本地立即刷新 UI** + **后端必须 publish SSE 通知同账号其他设备 + 受影响的其他用户**。两件事缺一不可，否则操作完成后某个端"看不到变化"。

**链路（蘑菇 2026-06-07 拍板）**：

1. **前端发起** —— `api/index.ts` request 函数自动给所有 fetch 加 `X-Quink-Client-Id` header（sessionStorage 每 tab 唯一）
2. **后端 handler 顶部** —— `const _ocid = c.req.header('X-Quink-Client-Id')` 拿到本次请求的设备 id
3. **后端写入完成后** —— 必须 `publish(userId, eventName, payload, _ocid)` 给操作者本人所有 SSE 连接，`_ocid` 透传让前端去重。涉及群成员 / 笔记其他读者时同时调 `broadcastNoteShared` / `broadcastNoteSocial` / `broadcastGroupChanged` 之类的群播 helper（这些也带 `_ocid` 参数）
4. **前端发起方** —— 不等 SSE 自己回环，**立即本地 mutate / 拉单条插入**让本设备 UI 即时反映（典型：`store.updateNote` Object.assign / `store.syncNoteCreated` 拉单条 / NoteCard 直接 mutate props.note）
5. **前端 sse.ts handler** —— 收到事件用 `isMyEvent(data)` 检查 `_originClientId` 是否本设备，是则跳过（本设备已直接 mutate 过了），不是则触发刷新（同账号其他设备 / 其他用户）

**新加写 endpoint 必做清单**：

1. handler 顶部 `const _ocid = c.req.header('X-Quink-Client-Id');`
2. 成功路径加 `publish(userId, 'xxx-changed', payload, _ocid)`（或专用事件名，如 `note-created` / `note-updated` / `note-deleted`）
3. 跨群 / 跨笔记的影响 → 同步调 `broadcastNoteShared(groupIds, userId, _ocid)` 等 helper
4. 前端 view setup 内加 `useSseSync('xxx', loadXxx)` composable 监听，或者复用现有事件 handler（详见 `packages/server/CLAUDE.md` "多设备 SSE 同步约定"）
5. 前端发起方（操作发起的 NoteCard / NoteEditModal / Settings 等）必须本地 mutate 不靠 SSE 回环 —— SSE 给本设备会被 `isMyEvent` 跳过

**反例（坑过的）**：

- doDuplicate 只 toast 不调 `store.syncNoteCreated` → 副本不出现在列表头（PR #9 followup 修）
- NoteCard 切 `editPermission` 只调 store.updateNote，但 GroupDetail 的 `groupNotes` 是本地 ref → 必须同时 mutate `props.note.editPermission` 让 reactive UI 立刻反映（PR #5b 修）
- `store.updateNote` in-place 路径之前只 fork 时派 `quink-group-notes-changed` → in-place 改自己笔记群组页不刷（PR #7b 修）
- 删除按钮 toast 没 try-catch 兜底 → 后端 403 时静默"什么都不提示"（PR #7b 修）

如果操作本身只影响发起者（如保存编辑器草稿到 localStorage），可以跳过 SSE 通知但本地必须刷新。其他场景统统两件事都做。

## UI 交互约定（跨 view 通用）

- **危险操作必须弹窗确认**（删除/清空/永久删除等），禁止在按钮原地切换文字。使用 `confirmXxxId` ref + Teleport 居中弹窗 + 取消/确认双按钮。
- **按钮要有背景色**：主要操作 `bg-primary-light text-primary-dark`，危险操作 `bg-red-50 text-red-500`，hover 加深。
- **数字显示用 `tabular-nums`** 等宽字体类，避免切换页面时数字跳动。
- **暗色主题全适配**：所有硬编码颜色必须在 style.css 加 `[data-theme="dark"]` 覆盖。
- **搜索高亮**统一用全局琥珀色（`#fbbf24` / `#d97706`），柠檬主题例外用紫色（避免黄底黄字）。
- **批量操作用乐观更新**：`恢复所有` / `清空回收站` 等批量 API 调用，**必须先改 UI 触发动画再 await API**。否则若 `Promise.all` 中任一 reject，整个 Promise.all reject → 空 catch 吞掉 → 数据变更（如 `notes.value = []`）不执行 → **动画不触发**。乐观更新代价是 API 失败时 server 数据不一致（UI 已清空 server 还有），下次刷新会自动同步；用 `console.error` 留痕。范例：`Trash.vue` 的 `doRestoreAll` / `doEmptyAll`。
- **批量操作完成自动退多选**：所有 store batch 函数（`batchDelete` / `batchMove` / `batchUpdateType` / `batchSetTodoStatus` / `batchAddTags`）以及拖动批量（cardDnd / Sidebar.doTrash）操作开始时即调 `store.exitSelectMode()`（清选中 + 退多选模式），await 期间 UI 已回到正常视图。理由：操作完成后选中已空，留在 selectMode 里所有 batch 按钮变 no-op，看着 awkward；连续批量场景极少，多一次点"多选"成本可接受。Trash / Resources 用本地 `selectMode` ref（不复用 store），自己也跟同样规则（`selectMode.value = false`）。

## 编码规范

### 命名规范

| 场景 | 规范 | 示例 |
|---|---|---|
| 数据库列名 | snake_case | `user_id`、`created_at`、`todo_status` |
| TypeScript 变量/函数 | camelCase | `userId`、`sendMessage`、`currentConvId` |
| TypeScript 类型/接口 | PascalCase | `Note`、`AiConfig`、`ChatMessage` |
| Vue 组件文件 | PascalCase | `NoteCard.vue`、`TopBar.vue` |
| CSS 类名 | kebab-case | `note-content`、`voice-bubble` |
| 常量 | UPPER_SNAKE_CASE | `DEFAULT_PROMPTS`、`TOOL_DEFINITIONS` |
| API JSON 响应字段 | camelCase | `{ userId, createdAt, todoStatus }` |

数据库查询约定（必须用 Drizzle ORM）详见 `packages/server/CLAUDE.md`。

## 专题指针（指向独立 .md / 子目录 CLAUDE.md）

- **图标系统** —— `@phosphor-icons/vue`、PhXCircle vs PhX、weight/size 规则、v-html 内嵌、视觉中心偏移 nudge。详见 **`ICONS.md`**。改图标相关代码前先读那里
- **渲染坑** —— DOM / CSS / Vue 模板 / HMR / markdown 渲染 / Vditor 编辑器 / TransitionGroup 动画 / 拖动鼠标事件。详见 **`RENDERING-PITFALLS.md`**。改 UI / markdown / 编辑器 / 列表动画前先去那里查
- **静态图片缩略图** —— sharp / libheif 后端生成 `.thumb.jpg` / 前端 `<img>` thumb URL + onError 降级 / 别用 background-image。详见 **`THUMBNAILS.md`**。改头像 / 资源缩略图 / upload.ts sharp 行为 / 加新图片显示场景前先读那里
- **z-index 体系** —— 全项目走 CSS 变量(`--z-sticky` / `--z-modal` / `--z-overlay` 等),代码里只写变量名不写数字。详见 **`Z-INDEX-SCALE.md`**。加新弹层 / popup / modal / overlay / dropdown 前先读那里
- **AI 系统（后端）** —— 多配置 / 按功能绑定 / FC v2 / `{categories}` 占位 / 弱模型适配 / chat prompt 三大块 / 引用 label 透传。详见 `packages/server/src/ai/CLAUDE.md`（在该子目录工作时自动加载）
- **卡片拖放（DnD）** —— pointer events 不用 HTML5 DnD / dropzone 协议表 / AI 拖入兜底 / audio anchor 例外。详见 **`packages/web/CARDDND.md`**。改 NoteCard 拖动 / Sidebar drop target / cardDnd / AI 拖入相关前先读那里
- **鼠标光标（Bibata 7 主题）** —— SVG 模板 + `$F$`/`$S$` 占位色脚本生成 / 7 主题 × 15 cursor / `loadThemeCursors` 按 `data-theme` 动态 `<link>` / 项目内写 cursor 必须用 `var(--cur-X), X` 否则 specificity 输 / Vditor / OS 窗口 / UA shadow DOM 改不了。详见 **`packages/web/CURSORS.md`**。改主题色 / 加新 cursor / 项目内写 `cursor: pointer` 前先读那里
- **跨视图筛选跳转** —— onActivated 派事件 + TopBar 监听三步约定 / mount 顺序依赖（TopBar 必须比 RouterView 先 mount，否则跳转静默失效）。详见 **`packages/web/CROSS-VIEW-NAV.md`**。加新跳转线 / 改 App.vue 顶层布局前先读那里
- **markdown 显示态** —— 笔记 markdown 渲染统一走"外层 `.note-content` + 内层 `.vditor-reset` 嵌套 v-html"的结构（**方案 C**），复用 Vditor 编辑器的 CSS 让显示态视觉跟编辑态完全一致。涉及 7 个文件：`NoteCard.vue` / `NoteDetail.vue` / `Trash.vue` / `App.vue`（引用预览）/ `AI.vue` / `AiChat.vue`。详见 `RENDERING-PITFALLS.md` 的"markdown 渲染"段
- **Electron 快捷窗口（Capture / AiChat）** —— Win11 OS 窗口动画 / 主题闪烁 4 层防御 / `currentTheme` 缓存同步 / 持久窗口 vs 销毁重建策略 / IPC 契约。详见 **`packages/desktop/CLAUDE.md`**。改 desktop 主进程或动 `Capture.vue` / `AiChat.vue` / `RichEditor.vue` / `index.html` 前先读那里
- **文件资源（url 裸名约定 + 重命名同步）** —— DB 存裸名，前端渲染层用 `packages/web/src/utils/fileUrl.ts` 的 helper 拼 `/api/uploads/` 前缀。后端逻辑详见 `packages/server/CLAUDE.md`，前端 helper 用法详见 `packages/web/CLAUDE.md`
- **卡片列表 leave 动画** —— `cardLeave.ts` + TransitionGroup 多个坑，详见 `packages/web/src/utils/CLAUDE.md`
- **瀑布流 + 无限滚动** —— `useMasonry` + `useInfiniteScroll` 体系，详见 `packages/web/src/composables/CLAUDE.md`
