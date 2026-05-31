# packages/web/src/composables/CLAUDE.md

本目录 Vue composable 相关坑。当前 5 个 composable，主要笔在**瀑布流 + 无限滚动体系**（`useMasonry` + `useInfiniteScroll`），这俩是组合使用的，单看一个看不懂为啥那样写。

## 文件清单

- `useToast.ts` — 全局 toast 单例
- `useTheme.ts` — 监听 `<html data-theme>` 属性变化的全局 ref（MutationObserver）
- `useImagePreview.ts` — 图片预览单例 state（配合 `components/ImagePreview.vue`）
- `useMasonry.ts` + `useInfiniteScroll.ts` — **瀑布流 + 无限滚动**，下面详细

涉及的 view：`Inspiration.vue` / `Notes.vue` / `Todos.vue` 都用这套。

## 瀑布流 + 无限滚动（useMasonry + useInfiniteScroll）

### 整体设计

```
<main overflow-y-auto>                              ← 滚动容器
  <view 根 div>
    <div class="notes-masonry">                     ← flex 横向,N 个 wrapper
      <div class="masonry-col-wrapper">             ← 列 wrapper(包 col + sentinel)
        <TransitionGroup class="masonry-col">       ← 每列独立 TransitionGroup
          <NoteCard v-for="note in col" ...>        ← 列内 vertical stack
        </TransitionGroup>
        <div class="col-sentinel" :ref="..." />     ← 列底 sentinel
      </div>
      ...                                           ← N 个 wrapper
    </div>
    <div v-if="notes.length < total">滚动加载更多</div>   ← 仅文案,无 ref
  </view 根 div>
</main>
```

useMasonry 把 `getItems()` 按"放最矮列"算法分配到 N 个 `T[]`，view v-for `columns` 输出多列 TransitionGroup。useInfiniteScroll 接受 sentinels 数组 ref，每列底部各 1 个 sentinel，**任一进入"视口 + 下方 25%"区域**就触发 `loadMore`。两者**完全不直接互相调用**，只通过 store.notes 反应式串起来。

### 坑 1：不能用 `column-count` CSS 多列布局

CSS `column-count: 3` 的瀑布流，**push 新元素时浏览器会重新平衡所有 children 到 3 列** → 已有元素的视觉位置变化 → 用户感觉"页面翻动了"。即使 `scrollTop` 数值不变，anchor 卡片实际位置也变了。

修法：用 `display: flex` 横向 + N 个独立 `.masonry-col` 子 div + 列内 `flex-direction: column`。push 只追加到末尾，已有元素位置绝对不变。**`.notes-masonry` 现在就是这样**（之前的 column-count 老代码已删）。

### 坑 2：computed 返回新数组 → TransitionGroup 整体重渲染

如果 useMasonry 用 `computed(() => { ... return cols })` 返回 columns，每次重算返回**全新数组引用**（包括每个 col 都是新数组）。TransitionGroup 看到 v-for source 是新数组，会触发整体 patch + FLIP move，**带来滚动跳变**。

修法：useMasonry 用 `ref<T[][]>` + watch 触发**增量 push**（`columns.value[col].push(newItem)` mutation，不替换 `columns.value` 引用）。Vue 反应式只追踪到"某列追加节点"，TransitionGroup 只 mount 新节点，已有节点 zero churn。范例：`useMasonry.ts` 的 `watch(getItems, ...)`。

### 坑 3：v-if loading 包整列表 + 滚动容器 = scrollTop 自动归零

view 里如果写：
```vue
<div v-if="store.loading">加载中...</div>
<template v-else>
  <div class="notes-masonry">...</div>
</template>
```

loadMore 期间 `store.loading=true` → 整个 `<template v-else>` unmount → `.notes-masonry` 销毁 → main 容器子树被 detach。loadMore 完成 `loading=false` → 重新 mount → **浏览器原生行为：滚动容器内容被 detach + attach 后 scrollTop 自动归零**！

这个 reset **不走 JS scrollTop setter**（spy 抓不到），是浏览器内部行为。**SPA + overflow 滚动容器 + v-if 大块切换** 是经典陷阱。

修法：让 loading v-if 只在**首屏加载**触发（notes.length === 0 时），loadMore 时 notes.length > 0 → 条件 false，整列表不 unmount。loadMore 的 loading 提示放底部 sentinel 内：
```vue
<div v-if="store.loading && store.notes.length === 0">加载中...</div>
<template v-else>
  <div class="notes-masonry">...</div>
  <div ref="sentinel" v-if="...">
    {{ store.loading ? '加载中...' : '滚动加载更多' }}
  </div>
</template>
```

范例：`Inspiration.vue` / `Notes.vue`。Todos.vue 本来就没顶部 loading，没坑。

### 坑 4：pickShortest 必须用真实 DOM 高度,不能纯靠 estimateHeight 累计

react-masonry-css 用 `i % N` round-robin,简单但**列高不平衡**(长内容刚好都落某列时差异可达一屏)。

修法:用 `pickShortestCol(列高)` 选最矮列。**列高来源必须用真实 DOM offsetHeight**,不能纯靠 estimateHeight 累计:

| 列 | 真实 offsetHeight | estimateHeight 累计 |
|---|---|---|
| col0 | 1791 | 1438 |
| col1 | 1819 | 1482 |
| col2 | **2244**(实际最高) | **1426**(被估算成最矮) |

estimateHeight 假设纯文本(`80 + lines*22`, 最多 4 行),不算 markdown 渲染 / 图片 / 音频。含图卡片估算 ~150 真实 542,误差 3 倍以上。结果 col2 真实最高 2244 反被算成最矮 1426 → 后续 loadMore 把新卡片继续往 col2 倒 → 列高越扯越歪(反馈循环)。

实现:`useMasonry(getItems, rootRef?)` 接受 `rootRef: Ref<HTMLElement | null>`(指向 `.notes-masonry`)。`measureRealHeights()` 通过 `rootRef.value.querySelectorAll(':scope > .masonry-col-wrapper > .masonry-col')` 拿真实 offsetHeight。触发时机:

- **rebuild 后 nextTick**(首屏 / 换 view / resize) —— DOM mount 后用真实值刷新 colHeights
- **删除后 nextTick** —— estimateHeight 减回不精确,真实重测一次
- **append 前**(loadMore) —— 直接读真实高当 baseline,新加项还没 mount 用 estimateHeight 临时预测

estimateHeight 保留兜底:rebuild 时还没 DOM,只能先估算分配,nextTick 后再修正。

**前 N 张所有列都是 0,行为自然退化成 round-robin → 第一行仍是最新 N 张("靠上越新"成立)**,之后按真实高度平衡。

view 必须传 rootRef:`<div ref="masonryRoot" class="notes-masonry">` + `useMasonry(getItems, masonryRoot)`。Todos 有 pending + done 两组各传各 root。不传 rootRef 退化回纯 estimateHeight(不推荐,会有反馈循环问题)。

selector 兼容老结构 `.notes-masonry > .masonry-col`(Trash 没用 useInfiniteScroll 不带 wrapper),fallback 到 wrapper 内层。

### 坑 5：scrollTop 调试诀窍

不知道 scrollTop 谁改的时候：
1. 加 `Object.defineProperty` 在 scrollTop 上挂 setter spy → 能抓到 JS `scrollEl.scrollTop = X` 的调用 stack
2. 加 sentinel 元素的 `.isConnected` 检查 → 看 sentinel 是否 unmount（v-if 切换的提示）
3. 比较 `before === after` 的 main 元素引用 → 看 main 是不是被换了
4. 监听 `scroll` event 数 → 看用户/程序触发了几次 scroll

**记住**：spy 抓不到 = scrollTop 不是被代码改的，**是浏览器自己归零**（多半是 unmount/remount）。这条断言救了至少一次（坑 3 就是这么定位的）。

### 坑 6：删除走 mutate / 筛选走 reassign，靠 `newItems !== oldItems` 区分

删除 / 恢复时如果无条件 `rebuild()`，pickShortest 会让 staying 笔记跨列移动 → TransitionGroup 原列 leave + 新列 enter → 误触发 onLeave 钩子 → 看着像"后面卡片跟着一起飞向 sidebar"（回收站 flyToNavLeave 时尤其醒目，Inspiration/Notes/Todos 用 fadeOutLeave 视觉不明显）。所以删除必须走增量 splice，只有筛选/搜索/换 view 才 rebuild。

区分方式：`watch(getItems, (newItems, oldItems) => ...)` 的两个参数。
- **reassign**（`notes.value = newArr`）→ `newItems !== oldItems` → rebuild
- **mutate**（`push` / `splice` / `unshift`）→ `newItems === oldItems`（deep watch 检测内部变化）→ 走 splice / append

**配套要求：store 操作 `notes.value` 时语义必须跟读写方式一致。** 尤其 `deleteNote` **不能**用 `notes.value = notes.value.filter(...)` —— `filter()` 返回新数组 + `=` 是 reassign，会被 useMasonry 误判为筛选 → 走 rebuild → 跨列重排闪烁。必须用 `findIndex + splice` 走 mutate。

**反向坑：往数组中间插入元素必须 reassign 不能 splice mutate**。`createNote` 把新非置顶笔记插到"所有置顶之后第一位"（避免初始位置在 [0] 比置顶还前），如果用 `notes.value.splice(insertIdx, 0, newNote)` mutate：
- newItems === oldItems → 走 mutation 路径
- length 增长 1 + firstId 没变（首位还是原置顶）→ 走 append 分支
- append 分支假定新元素**在数组末尾**（loadMore 模式），把 `newItems[lastLength]` 当新卡片加到最矮列 —— 但 newItems[lastLength] 实际是 splice 后原本在 lastLength 位置的元素（旧的），**拿错卡片重复显示在末尾列**

修法：`createNote` 用 `const next = [...notes.value]; next.splice(idx, 0, newNote); notes.value = next` reassign，让 useMasonry 走 rebuild 全量重排。代价是触发一次 rebuild（与原 unshift 走 firstChanged rebuild 同代价），但位置正确。**任何"往中间插入"的场景都得 reassign**，append 分支只能服务尾部追加。

### 配合 store 的动态 pageSize

每个 view 在 setup 里 watch `columnCount` → 同步 `store.pageSize = n * 10`。3 列 30、4 列 40、5 列 50，刚好首屏 10 行。`store.fetchNotes` 用 `pageSize.value` 替代硬编码 limit。

### 坑 7：sentinel 必须每列各 1 个,不能全列表共用 1 个

老做法把 sentinel 放在 `.notes-masonry` 之后(全列表底部全宽 div),DOM 流上紧贴**最长列**底。列高不齐时(尤其删卡片后),短列已大片空白,但 sentinel 还在最长列底 → 必须等最长列也快触底才触发 `loadMore`,用户感觉"半天不加载"。

修法:每列底部各放 1 个 sentinel(`.col-sentinel`),`IntersectionObserver` 监测**任一**进入"视口 + 下方 25%"区域就 loadMore(`rootMargin: '0px 0px 25% 0px'`)。短列空白接近视口高度 25% 就触发,跟最长列状态无关。

DOM 结构: `.notes-masonry > .masonry-col-wrapper > (TransitionGroup.masonry-col + .col-sentinel)`。wrapper 接管 flex 子项角色(`flex: 1 1 0`),sentinel 跟 TransitionGroup 同层避免塞进 TransitionGroup 触发 enter/leave 钩子。Trash 没用 useInfiniteScroll,直接拿 `.masonry-col` 当 `.notes-masonry` 子项(不带 wrapper),`.masonry-col` 自带 `flex: 1 1 0` 没 wrapper 也能布局。

Todos 有 pending + done 两组瀑布流,sentinels 数组用**固定偏移**避免索引碰撞: pending 段 `sentinels[ci]`(0..N-1),done 段 `sentinels[100 + ci]`(100..100+N-1)。**不能用 `sentinels[columnCount + ci]`**: columnCount resize 变化时,unmount 回调读到的是新 columnCount → 写到错位索引 → 旧 DOM ref 残留在数组里 → observer 永久持有 detached DOM(内存泄漏)。

### 配合 view 的 push 模式

`store.fetchNotes` 内 append 时用 `notes.value.push(...newOnes)` 而非 `notes.value = [...notes.value, ...newOnes]` 替换。Pinia setup store 的 ref 数组用 mutation 是响应式的，但**不会让 TransitionGroup 当作"整体替换"**。范例：`stores/notes.ts` 的 fetchNotes 内 append 分支。

## 其他 composables 简记

### useTheme

模块加载时启动 MutationObserver 监听 `<html data-theme>` 属性变化，更新全局 `currentTheme` ref。所有需要响应主题切换的组件（标题栏 logo / 关于页 logo / 登录页 logo / Settings 主题选择器）都用这个，无需 props 传递。HMR 友好：模块级 `window.__quinkThemeObserver` 缓存 observer，HMR 重载先 disconnect 旧的。

### useImagePreview

全局单例 image preview state。任意位置调 `open(images, idx)` 触发预览。Resources 列表点图、`.note-content img` 全局 click delegate（在 App.vue）、MediaContextMenu 右键预览，都共享同一个 ImagePreview 组件实例（挂在 App.vue 顶层）。
