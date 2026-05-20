# packages/web/src/utils/CLAUDE.md

本目录工具函数相关坑。当前主要是 `cardLeave.ts`（笔记卡片列表 leave 动画体系）。**改这些 helper 或者在 view 里用它们时先读本文件**。

涉及的 view（都用 cardLeave）：`Trash.vue` / `Inspiration.vue` / `Notes.vue` / `Todos.vue` / `Resources.vue` / `Tags.vue` / `Settings.vue`。

## 列表删除/恢复动画体系（cardLeave.ts）

helper 提供 4 个函数：
- `fadeOutLeave` — 用于 column-count masonry / CSS grid / flex-wrap 容器
- `collapseLeave` — 用于垂直列表（space-y / flex-col）
- `flyToNavLeave` — 回收站恢复时飞向 sidebar 对应导航
- `fadeInEnter` — 配合 leave 形成对称过渡（待办状态切换用）
- `snapshotCards` — 在数据变更前主动 snapshot 所有卡片位置（防 onLeave 钩子拿到错位坐标）

### TransitionGroup + JS `@leave` 钩子的 4 个坑

- **坑 1：leave 钩子拿到的是 v-if 切换后的错位坐标**。Vue 的 patch 顺序里，v-if 切换（顶部工具栏 `v-if="notes.length > 0"` 消失、空提示 `v-if="notes.length === 0"` 出现）会先于 TransitionGroup 的 leave 钩子执行。leave 钩子里 `getBoundingClientRect()` 拿到的是容器被推位移**后**的坐标，所有 leaving 元素"瞬移"。修法：view 里加 `watch(() => list.length, () => snapshotCards(), { flush: 'sync' })`，在 reactive 变化的**同一同步上下文**里主动 snapshot 所有卡片当前位置（DOM 还没 patch，位置准确），leave 钩子直接读 WeakMap 缓存。

- **坑 2：onLeave 同步设 `transition: transform` 会被 Vue FLIP 清空 transitionDuration 导致瞬间到位**。Vue TransitionGroup 在 `onUpdated`（leave 钩子之后**同步**执行）里跑 FLIP move：`hasCSSTransform` 检查"元素有没有 transform transition"——它**克隆元素**并复制 inline style，看到我设的 `transition: transform 0.5s` 后返回 true → 给所有 leaving 元素加 `v-move` class **并清空 `style.transitionDuration = ''`** → RAF 后设的 transform 瞬间到位（典型症状："全没了 没动画"）。修法：**两层 RAF 推迟 inline transition 设置**到 onUpdated 之后。第一层 RAF 设 `transition`，第二层 RAF 设 `transform` 触发动画。这样 hasCSSTransform 检查 clone 时 inline 没有 transition: transform，返回 false → 跳过 FLIP → 不清空 duration。

- **坑 3：staying 元素"平滑对齐"动画依赖 class 上的 `transition-transform`**。Vue FLIP 给 staying（没被删的）元素设 transform 做位置补偿，紧接着 `addTransitionClass(v-move)`——但 `v-move` CSS 没定义，所以 transform 变化没过渡，**剩余卡片瞬间补位**。`NoteCard.vue` 因为有 `transition-all duration-200`（本来给 hover 阴影用）顺带让 FLIP move 生效，所以待办/灵感页删除时剩余卡片有平滑对齐动画。新列表组件想要这个效果必须主动加 `transition-transform duration-300`。范例：`Trash.vue` 的卡片 div。

- **坑 4：批量 leave 时不能在 onLeave 内部第一次遍历兄弟元素 snapshot**——浏览器会在第一次 `position:fixed` + 第二次读 BCR 之间 flush layout，剩余卡片被 column-count 重排到 column 1 顶部，所有后续 leave 钩子拿到的都是 column 1 顶部坐标 → 全 fixed 到一处重叠。所以 snapshot 必须在数据变更**前**完成（靠 watch flush:'sync'）。

- `:css="false"` 只跳过 enter/leave 的 CSS class 操作，**不阻止 FLIP move**（FLIP 是 Vue 内部逻辑，照常跑）。要绕开 FLIP 要么用上面坑 2 的推迟方案，要么把 leaving 元素 detach 出 TransitionGroup 容器（更激进但 Vue removeChild 时会报错）。

## helper 选型 cheat sheet

选哪个 leave 函数**完全看容器布局**：

- **`column-count` masonry / CSS `grid` / `flex flex-wrap`** → `fadeOutLeave`：leaving 项 `position: fixed` 脱流，剩余项靠布局自然重排。范例：`Inspiration.vue` / `Notes.vue` / `Todos.vue` / `Resources.vue`（grid） / `Tags.vue`（flex-wrap）。

- **垂直列表**（`space-y-*` / `flex flex-col`）→ `collapseLeave`：leaving 项 max-height 从当前高度渐变到 0 + opacity 0 + margin/padding 归零，**留在 flow 中"挤扁"**，外层容器高度跟着自然平滑减小。**用错 `fadeOutLeave` 会让外层容器瞬间塌缩**（leaving 项 position:fixed 一瞬间脱流，layout 立刻重计算）—— 典型症状："白底框收缩太快没动画"。范例：`Settings.vue` 的 AI 配置列表。

- **回收站恢复** → `flyToNavLeave`：飞向 sidebar 上 type 对应的导航菜单项（内部已 lockToScreen，不论容器布局都能用）。

- **staying 元素"对齐/补位"动画要在 v-for 子元素 class 上加 `transition-all duration-300`**（或 `transition-transform`），让 Vue FLIP 给 staying 元素设的 transform 变化能过渡。否则被删项淡出后剩余项瞬间补位（看着"砰一下"补上去）。`NoteCard` 因为本身有 `transition-all duration-200`（hover 阴影用）顺带让 FLIP 生效，其他列表组件必须主动加。

- **`snapshotCards` 调用时机**：`fadeOutLeave` / `flyToNavLeave` 必须配合 `watch(() => list.length, () => snapshotCards(), { flush: 'sync' })`（在数据变更前 snapshot 位置，避免 onLeave 钩子拿到 v-if 切换后的错位坐标）；`collapseLeave` **不需要 snapshot**（不脱流，不锁位置）。

- **批量操作要用乐观更新**：`恢复所有` / `清空回收站` / 批量删除 AI 配置等，必须先改 UI 触发动画再 await API（否则 Promise.all reject 会让 `notes.value = []` 不执行，动画不触发）。范例：`Trash.vue` 的 `doRestoreAll` / `Tags.vue` 的 `doDeleteTag` / `Settings.vue` 的 `deleteConfig`。

- **容器要加 `data-animated-list` 属性**（grid / flex-wrap / 垂直列表的 TransitionGroup 容器都加），让 `snapshotCards()` 默认 selector 能匹配到。`.notes-masonry` 容器不用加（默认 selector 已包含）。
