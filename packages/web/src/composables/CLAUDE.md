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
<main overflow-y-auto>                       ← 滚动容器
  <view 根 div>
    <div class="notes-masonry">              ← flex 横向,N 个子 col
      <TransitionGroup class="masonry-col">  ← 每列独立 TransitionGroup
        <NoteCard v-for="note in col" ...>   ← 列内 vertical stack
      </TransitionGroup>
      ...                                    ← N 个 col
    </div>
    <div ref="sentinel" v-if="notes.length < total">  ← IntersectionObserver 监听
      滚动加载更多
    </div>
  </view 根 div>
</main>
```

useMasonry 把 `getItems()` 按"放最矮列"算法分配到 N 个 `T[]`，view v-for `columns` 输出多列 TransitionGroup。useInfiniteScroll 在 sentinel 进入视口前 300px 触发 `loadMore`。两者**完全不直接互相调用**，只通过 store.notes 反应式串起来。

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

### 坑 4：pickShortest 算法 vs round-robin

react-masonry-css 用 `i % N` round-robin，简单但**列高不平衡**（长内容刚好都落某列时差异可达一屏）。

修法：用 `pickShortestCol(累计估算高度)` 选最矮列。`estimateHeight` 按 content 字符数 + tags + summary 估算（不测真实 DOM）。**前 N 张所有列都是 0，行为自然退化成 round-robin → 第一行仍是最新 N 张（"靠上越新"成立）**，之后开始按高度平衡。

估算误差最大场景：含图片 / 音频胶囊 / 长 markdown 渲染（h1/代码块/列表）的卡片。一般日常笔记够用。如果要彻底准，升级到 ResizeObserver + DOM offsetHeight，但复杂度上升 2 倍，先不做。

### 坑 5：scrollTop 调试诀窍

不知道 scrollTop 谁改的时候：
1. 加 `Object.defineProperty` 在 scrollTop 上挂 setter spy → 能抓到 JS `scrollEl.scrollTop = X` 的调用 stack
2. 加 sentinel 元素的 `.isConnected` 检查 → 看 sentinel 是否 unmount（v-if 切换的提示）
3. 比较 `before === after` 的 main 元素引用 → 看 main 是不是被换了
4. 监听 `scroll` event 数 → 看用户/程序触发了几次 scroll

**记住**：spy 抓不到 = scrollTop 不是被代码改的，**是浏览器自己归零**（多半是 unmount/remount）。这条断言救了至少一次（坑 3 就是这么定位的）。

### 配合 store 的动态 pageSize

每个 view 在 setup 里 watch `columnCount` → 同步 `store.pageSize = n * 10`。3 列 30、4 列 40、5 列 50，刚好首屏 10 行。`store.fetchNotes` 用 `pageSize.value` 替代硬编码 limit。

### 配合 view 的 push 模式

`store.fetchNotes` 内 append 时用 `notes.value.push(...newOnes)` 而非 `notes.value = [...notes.value, ...newOnes]` 替换。Pinia setup store 的 ref 数组用 mutation 是响应式的，但**不会让 TransitionGroup 当作"整体替换"**。范例：`stores/notes.ts` 的 fetchNotes 内 append 分支。

## 其他 composables 简记

### useTheme

模块加载时启动 MutationObserver 监听 `<html data-theme>` 属性变化，更新全局 `currentTheme` ref。所有需要响应主题切换的组件（标题栏 logo / 关于页 logo / 登录页 logo / Settings 主题选择器）都用这个，无需 props 传递。HMR 友好：模块级 `window.__quinkThemeObserver` 缓存 observer，HMR 重载先 disconnect 旧的。

### useImagePreview

全局单例 image preview state。任意位置调 `open(images, idx)` 触发预览。Resources 列表点图、`.note-content img` 全局 click delegate（在 App.vue）、MediaContextMenu 右键预览，都共享同一个 ImagePreview 组件实例（挂在 App.vue 顶层）。
