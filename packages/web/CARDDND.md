# 卡片拖放（DnD）协议

NoteCard 拖到 sidebar（改 type / 改 category / 删除 / 加进 AI）走自定义 `utils/cardDnd.ts`，**不用 HTML5 DnD**。

本文档手动加载。改 `cardDnd.ts` / `DragGhost.vue` / `NoteCard.vue` 的拖动逻辑 / `Sidebar.vue` 的 drop target / `AI.vue` 的拖入兜底前来读。

## 为什么不用 HTML5 DnD

Chromium 在 DnD 期间彻底拦截 wheel 事件（即使 capture phase + preventDefault 也拿不到），导致拖动卡片到 sidebar 时**无法用滚轮滚到更多目标**。换 pointer events 之后 wheel 正常派发。

## dropzone 协议

drop 目标 DOM 元素加 `data-drop-target="xxx"`，值约定：

| 值 | 含义 |
|---|---|
| `type:note` / `type:snippet` / `type:todo` | 改卡片 type；**停留 400ms 自动 navigate** 到对应视图（`/` / `/notes` / `/todos`），拖动不释放，松手仍 commit type 变更 |
| `cat:<分类名>` | 改 category |
| `action:trash` | 软删除（cardDnd 派 `quink-drop-trash` 事件让 Sidebar 弹确认 modal） |
| `action:ai` | 拖到 sidebar AI 项 — 直接松手 = 跳 /ai 新对话；停留 400ms 自动 navigate /ai（拖动不释放，鼠标继续拖到 conv） |
| `conv:<convId>` | /ai 页面内拖到指定对话 |
| `ai-page` | /ai 页面兜底（chat area / 输入框区域） |

**Hover-navigate 实现**：cardDnd 用单个 timer (`hoverNavTimer`) + `navigatedTarget` 去重，target → path 走 `hoverTargetToNavPath` 映射。同一拖动里每个 target 只 navigate 一次。派 `quink-ai-expand` event（名字历史遗留，detail.path 区分目标）→ Sidebar 监听 navigate。同 view 同 type 已被 `from === to` 拒绝（hoverTarget=null），不会触发跳到当前视图。

**hover navigate 跟 store.updateNote 的耦合**：hover navigate 把"源 view = 当前 / 目标 view = 后台"反转成"源 view = 后台 / 目标 view = 当前"。`store.updateNote` 因此走 4-case 对称化处理（按 `activeView` 跟 `targetViewKey` 关系决定 Object.assign vs 直接 insert vs 标 dirty），不然源 view 后台 + Object.assign 改 type → Todos 的 `pendingTodos.filter` computed 重算触发 useMasonry rebuild 在 detached DOM 上塞同一列。详见 `packages/web/CLAUDE.md` "跨 view 改 type 4 case 对称化"段。

## 触发 + 视觉

**触发**：NoteCard `@pointerdown` 调 `startCardDrag(e, { ids, type, category, text, html? })`。type chip 在非 selectMode 充当 drag handle（让正文 select-text 不被 DnD 抢）。

**多选拖动规则**（蘑菇 2026-06-07 修订）：
- `selectMode === true` → 拖的永远是**被选中**的卡片（`Array.from(store.selectedIds)`），**不管鼠标按住哪张**（按未选卡片 = 拖整个选中集；按已选卡片也是同效果）。
- `selectMode && size === 0` → onPointerDown 直接 `return`，不响应（多选模式按未选区不应抓起任何东西）。
- 非 selectMode → 单选拖当前卡片 `props.note.id`。
- 之前的"selectMode + 当前在选中集 + size≥2"判断已废弃。

**视觉**：`dragState.hoverTarget` 给 dropzone 加 `drop-target-active` class；`<DragGhost />`（App.vue 全局挂载）fixed 跟随鼠标。

**Ghost markdown 渲染**：
- **单选**: NoteCard `onPointerDown` 传 `html: renderedContent.value`（复用 watchEffect 已 Vditor.md2html 渲染好的 HTML，零开销）→ DragGhost 单 ghost 紧跟鼠标位置 (`ghostX/Y`)。
- **多选** (蘑菇 2026-06-07): cardDnd `onMove` 启动拖动时遍历 selectedIds 用 `document.querySelector('[data-note-id="X"] .note-content .vditor-reset').innerHTML` 拿已渲染 HTML, 同时算每张卡片的 viewport 中心 → 算 ghosts 整体的几何中心 → 每张 ghost 记 `relCenterX/Y = origCenter - allGhostsAvgCenter`。**用 sqrt 缩放** `relCenter = sign(rel) * min(sqrt(|rel|) * SCALE, MAX_OFFSET)` (SCALE=3, MAX_OFFSET=120) 让 ghosts 集中在鼠标 120px 内、保留原始相对方向 + 距离顺序、但远距离衰减更明显 (100px→30px, 400px→60px, 900px→90px, 2500px→cap 120)。
- **多选 ghost 渲染位置**: DragGhost 模板 `:style="multiGhostStyle(g, dragState.ghostX, dragState.ghostY)"`, `mouseX/Y` 必须当参数传入 (Vue 不 track 跨函数 reactive)。`left = mouseX + relCenterX`, `top = mouseY + relCenterY`, `transform: translate(-50%, -50%)` 让 ghost 中心对齐目标位置。所有 ghost 复用单选同款 `.ghost-md-preview` 紧凑样式 (`bg-white + border + shadow-lg + rounded-lg + min-w 160 / max-w 320 / max-h 140 + opacity-90`)。
- **HTML 清理**: `ghostHtmlClean` / `cleanHtmlStr` 用 `/>\s+</g` → `><` 清元素间 `\n` text node + `/(\s|<br\s*\/?>)+$/i` 剥末尾。否则 ghost 内 inline context 下 `\n` 形成 anonymous inline box (line-height ~18px) 多出"一行白边"。
- **CSS 坑**: 不要给 ghost-md-preview 加 `::after` linear-gradient fade-mask, 内容未触发 max-height 截断时 mask 会把最后一段 P 覆盖压白看起来像"底部空白边"。用纯 `overflow: hidden` 硬截断即可。

## 多个边界

- **same-type / same-cat 跳过**：单条且 from === to 时 hoverTarget=null（视觉/语义都拒绝）；多条混合 type 时 fromType=null 始终接受。
- **AI 拖入兜底**：cardDnd 同时派 window 事件 + sessionStorage 中转（`quink_ai_pending_drop`）。AI mount 前丢失的事件由 onMounted/onActivated 读 sessionStorage 兜底；listener 收到也 removeItem 避免 onActivated 切回重复消费（已踩坑）。
- **胶囊 audio anchor 例外**：NoteCard `onPointerDown` 内检查 e.target 是不是 audio anchor，是 → return 让 `audio.ts` 的 pointer 监听接管 seek 拖动。
- **音频胶囊 CSS 选择器跟 token query 的耦合**：`style.css` 胶囊样式用 `[href$=".m4a"]` 后缀匹配，但 PR #3 群组文件授权后 `/api/uploads/*` href 尾部带 `?token=<jwt>` → 后缀匹配失效，胶囊视觉消失。修法：所有 audio 扩展（webm/mp3/wav/ogg/m4a）的选择器（基础样式 + `:hover` + `::before` 图标 + `::after`）都加 `[href*=".ext?"]` 模糊匹配变体并列。后续给 `/api/uploads/*` 改鉴权方式时注意保持 url 结构兼容 attribute selector。

## 涉及文件

`utils/cardDnd.ts` / `components/DragGhost.vue` / `NoteCard.vue` / `Sidebar.vue` / `AI.vue`。
