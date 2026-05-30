# 跨视图筛选跳转

view A 触发跳转 → view B 落地并自动应用筛选 chip 的模式。当前 2 条线：Stats 热力图 → 灵感页按日期；Inspiration tag → 灵感页按标签。

本文档手动加载。**加新的跨视图跳转线 / 改 App.vue 顶层布局**时来读。

## 三步统一约定

1. **触发方**：`router.push({ path: 目标 view, query: { 筛选键: 值 } })`
2. **目标 view 的 `onActivated`**：读 `route.query.筛选键`，命中则**只设 `store.filterType = ''` + 派事件**（`dispatchEvent('quink-filter-XXX', { detail: 值 })`），**不要自己 `fetchNotes`**
3. **TopBar `onMounted`** 监听 `quink-filter-XXX`：设对应筛选状态（chip / 日期 / types 全选）+ `showFilters = true` + `doSearch(true)` 统一拉数据

## 为什么 onActivated 不能自己 fetchNotes

否则会"onActivated 拉一次 + TopBar doSearch 又拉一次"= 后端 2 倍请求 + UI 数据填充 2 次闪烁 + TransitionGroup 动画打断。统一让 TopBar 负责数据拉取。

## 时序：路由 watch 先清，onActivated 后盖

TopBar 的 `watch(route.path)` 会先清空旧筛选，目标 view 的 `onActivated` 必须**在路由切完后**派事件才能盖回。当前两条线都走 onActivated 这条路径，顺序天然对。

## ⚠️ mount 顺序依赖

派事件模式要求 **TopBar 比 RouterView 先 mount**，否则 onMounted 注册监听器之前事件就派完了，监听器收不到 → 跨视图跳转**静默失效**（无报错，但 chip 不显示、数据不刷新，看到的是旧内容）。

当前 `App.vue` 里 `<TopBar />` 写在 `<RouterView />` 前（line ~437/439），顺序天然对。**如果挪布局把 TopBar 挪到 RouterView 后面，D2 / tag query 都会裂**。

## 涉及文件

`Stats.vue`（cell click）/ `Inspiration.vue`（query 分支）/ `TopBar.vue`（事件监听）。加新跳转线时三处都要补。
