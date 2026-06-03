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

**触发**：NoteCard `@pointerdown` 调 `startCardDrag(e, { ids, type, category, text })`。selectMode + 当前卡片在选中集 + size≥2 → ids 是整批；否则单条。type chip 在非 selectMode 充当 drag handle（让正文 select-text 不被 DnD 抢）。

**视觉**：`dragState.hoverTarget` 给 dropzone 加 `drop-target-active` class；`<DragGhost />`（App.vue 全局挂载）fixed 跟随鼠标。

## 多个边界

- **same-type / same-cat 跳过**：单条且 from === to 时 hoverTarget=null（视觉/语义都拒绝）；多条混合 type 时 fromType=null 始终接受。
- **AI 拖入兜底**：cardDnd 同时派 window 事件 + sessionStorage 中转（`quink_ai_pending_drop`）。AI mount 前丢失的事件由 onMounted/onActivated 读 sessionStorage 兜底；listener 收到也 removeItem 避免 onActivated 切回重复消费（已踩坑）。
- **胶囊 audio anchor 例外**：NoteCard `onPointerDown` 内检查 e.target 是不是 audio anchor，是 → return 让 `audio.ts` 的 pointer 监听接管 seek 拖动。

## 涉及文件

`utils/cardDnd.ts` / `components/DragGhost.vue` / `NoteCard.vue` / `Sidebar.vue` / `AI.vue`。
