import { defineStore } from 'pinia';
import { ref, shallowRef, computed, reactive } from 'vue';
import { api, type Note } from '@/api';

// 3 个主 view 各自独立的状态. 切 view 不重拉 → scrollTop / 已 loadMore 的条数都保留.
// notes/total/currentPage/lastExtra 全部 view-local; searchQuery/filterType/filterCategory
// 保持全局(TopBar 路由变化时已主动清 searchQuery, 不会跨 view 污染).
type ViewKey = 'inspiration' | 'notes' | 'todos';

interface ViewState {
  notes: Note[];
  total: number;
  currentPage: number;
  scrollTop: number;
  // 记上次 fetchNotes 的 extra (tag/tags/types/dateFrom/dateTo), loadMore 时复用避免丢过滤
  lastExtra?: { tag?: string; tags?: string; types?: string; dateFrom?: string; dateTo?: string };
}

function createInitState(): ViewState {
  return { notes: [], total: 0, currentPage: 1, scrollTop: 0, lastExtra: undefined };
}

export const useNotesStore = defineStore('notes', () => {
  const _viewState = reactive<Record<ViewKey, ViewState>>({
    inspiration: createInitState(),
    notes: createInitState(),
    todos: createInitState(),
  });
  // 当前激活 view. '' 表示不在 3 主 view 内(Trash/Resources/Tags/Stats/NoteDetail 等).
  // store action 在 activeView='' 时 no-op, 避免误操作.
  const activeView = ref<ViewKey | ''>('');

  // 当前 view 的 ViewState (computed 反映 activeView). 用空 state 兜底, 避免空判分散
  const _emptyState: ViewState = createInitState();
  const current = computed<ViewState>(() => activeView.value ? _viewState[activeView.value] : _emptyState);

  // 对外暴露的 notes/total/currentPage 都是 computed 反映 activeView. 外部组件(Sidebar/NoteDetail)
  // 直接用 store.notes 拿到"当前 view 的 notes" — KeepAlive 缓存的 view 内部 *不* 走这个共享接口
  // (会触发跨 view watch 误 rebuild), 它们走 store.getViewState(myKey) 拿专属 ViewState.
  const notes = computed<Note[]>(() => current.value.notes);
  const total = computed(() => current.value.total);
  const currentPage = computed(() => current.value.currentPage);

  const loading = ref(false);
  // 每页拉多少条 = columnCount * 10 (view 通过 watch columnCount 同步过来)
  // 默认 30 对应 3 列(最常见的桌面端 900-1400px)
  const pageSize = ref(30);
  const searchQuery = ref('');
  const filterCategory = ref('');
  const filterType = ref('');
  // 是否有用户主动的筛选 (搜索/分类/标签/类型/日期)。由 TopBar watchEffect 写入,
  // 各 view 用它隐藏顶部 NoteInput 编辑区,避免筛选状态下还让用户新写笔记
  const isFiltering = ref(false);
  const sortBy = ref<'created' | 'updated'>('created');
  // 资源页筛选: 跟 TopBar 筛选面板共享(类型 + 日期),不属于笔记 fetchNotes 参数,Resources view 自己 watch
  const fileCategory = ref<'all' | 'image' | 'audio' | 'document'>('all');
  const fileDateFrom = ref('');
  const fileDateTo = ref('');
  // 当前 view 的 refresh 函数. view 在 onActivated 注册, onDeactivated 注销(检查 === 防竞争).
  // TopBar 顶部刷新按钮按当前 view 调对应函数, 没注册时 fallback 到 fetchNotes keepCount.
  // shallowRef: ref 持有函数不需要 deep reactive.
  const currentRefresh = shallowRef<(() => Promise<void> | void) | null>(null);

  // view 拿自己专属 ViewState 的入口. view 内 useMasonry 用 () => myVs.notes 不通过 store.notes,
  // 避免 activeView 切换时 KeepAlive 缓存的旧 view 的 useMasonry watch 被误触发(共享 reactive 接口陷阱).
  function getViewState(key: ViewKey): ViewState {
    return _viewState[key];
  }

  // Sorted notes (当前 view 的, 用于 groupedByDate)
  const sortedNotes = computed(() => {
    return [...notes.value].sort((a, b) => {
      const dateA = sortBy.value === 'updated' ? a.updatedAt : a.createdAt;
      const dateB = sortBy.value === 'updated' ? b.updatedAt : b.createdAt;
      return dateB.localeCompare(dateA);
    });
  });

  // Group notes by date
  const groupedByDate = computed(() => {
    const groups: Record<string, Note[]> = {};
    for (const note of sortedNotes.value) {
      const dateField = sortBy.value === 'updated' ? note.updatedAt : note.createdAt;
      const date = dateField.slice(0, 10);
      if (!groups[date]) groups[date] = [];
      groups[date].push(note);
    }
    return groups;
  });

  async function fetchNotes(
    extra?: { tag?: string; tags?: string; types?: string; dateFrom?: string; dateTo?: string },
    opts: { append?: boolean; keepCount?: boolean } = {}
  ) {
    // activeView 不是 3 主 view 时 no-op (Trash/Resources 等自己管数据)
    const view = activeView.value;
    if (!view) return;
    const vs = _viewState[view];

    // 模式:
    //   - 默认 (reset): 首次/换 filter, page=1 limit=pageSize, 替换 notes
    //   - append:      loadMore, page=currentPage+1 limit=pageSize, push 到 notes 尾
    //   - keepCount:   refresh(顶部刷新按钮), page=1 limit=max(pageSize, notes.length),
    //                  替换 notes 但保持条数 → scrollTop 不跳, loadMore 接得上
    if (!opts.append && !opts.keepCount) {
      vs.currentPage = 1;
      vs.lastExtra = extra;
    } else if (opts.keepCount) {
      // refresh 保留 lastExtra,避免丢过滤条件(refresh() 通常不传 extra)
      extra = vs.lastExtra;
    }
    loading.value = true;
    try {
      const limit = opts.keepCount
        ? Math.max(pageSize.value, vs.notes.length)
        : pageSize.value;
      const params: Record<string, string> = {
        page: opts.keepCount ? '1' : String(vs.currentPage),
        limit: String(limit),
      };
      if (searchQuery.value) params.search = searchQuery.value;
      if (filterCategory.value) params.category = filterCategory.value;
      if (filterType.value) params.type = filterType.value;
      if (extra?.tag) params.tag = extra.tag;
      if (extra?.tags) params.tags = extra.tags;
      if (extra?.types) params.types = extra.types;
      if (extra?.dateFrom) params.dateFrom = extra.dateFrom;
      if (extra?.dateTo) params.dateTo = extra.dateTo;

      const res = await api.getNotes(params);
      if (opts.append) {
        // 去重:服务端分页边界可能有重叠,id 已存在的跳过
        const existing = new Set(vs.notes.map(n => n.id));
        const newOnes = res.data.filter(n => !existing.has(n.id));
        // 用 push() 追加到现有数组,不替换 ref —— 否则 TransitionGroup 把整个数组视为新引用,
        // 重建所有 DOM 节点导致容器短暂塌缩,滚动位置回到顶部
        vs.notes.push(...newOnes);
      } else {
        vs.notes = res.data;
      }
      vs.total = res.pagination.total;
      if (opts.keepCount) {
        // 重算 currentPage 让 loadMore 接得上:已加载 90 条 pageSize 30 → currentPage=3,
        // 下次 loadMore 拉 page=4. 用 res.data.length 而非 notes.length 是因为 server 可能
        // 返回少于请求(total 缩水时,如别处删了 note)
        vs.currentPage = Math.max(1, Math.ceil(res.data.length / pageSize.value));
      }
    } finally {
      loading.value = false;
    }
  }

  async function loadMore() {
    const view = activeView.value;
    if (!view) return;
    const vs = _viewState[view];
    if (loading.value || vs.notes.length >= vs.total) return;
    vs.currentPage++;
    await fetchNotes(vs.lastExtra, { append: true });
  }

  // type → 对应 view 的映射. note → 灵感, snippet → 笔记, todo → 待办. link 类型暂无专属 view,
  // 不加到任何本地 viewState (等下次目标 view fetchNotes 才拉到).
  const typeToView: Record<string, ViewKey> = {
    note: 'inspiration',
    snippet: 'notes',
    todo: 'todos',
  };

  async function createNote(content: string, type: string = 'note', tags?: string[]) {
    const res = await api.createNote({ content, type, tags });
    // 按新笔记 type 决定加到哪个 viewState, 不绑当前 activeView. 这样跨 view 创建 (如在灵感页
    // 用 Capture 创建 type=todo) 切到对应 view 立刻看到, 不用等 fetchNotes.
    const targetViewKey = typeToView[res.data.type];
    if (targetViewKey) {
      const vs = _viewState[targetViewKey];
      // 后端按 pinned DESC, updated_at DESC 排, 新非置顶笔记直接插到所有置顶之后的第一位.
      // 后续 pollNoteAiResult 走 mutate Object.assign 不重排, 初始位置就是最终位置 ── 否则
      // unshift 到 [0] 会先 "比置顶还前", 视觉上需要等到下一次全量 fetchNotes 才修正.
      // reassign 数组 (而非 splice mutate) 让 useMasonry 走 reassign rebuild 全量重排;
      // 不能用 splice mutate ── useMasonry append 路径假定新元素在末尾, 会拿错卡片 (composables/CLAUDE.md 坑 6)
      const insertIdx = vs.notes.findIndex((n) => !n.pinned);
      const next = [...vs.notes];
      if (insertIdx === -1) next.push(res.data);
      else next.splice(insertIdx, 0, res.data);
      vs.notes = next;
      vs.total++;
    }
    return res.data;
  }

  async function updateNote(id: string, data: Partial<Note>) {
    const res = await api.updateNote(id, data);
    // 改字段不只影响当前 view, 也要同步到所有 view 的本地 notes (例如笔记标签变化, 灵感 view 里的副本也要刷新)
    // mutate 字段而非替换引用: useMasonry 的 columns 里存的是 notes 元素引用,
    // 用 notes.value[idx] = newObj 替换数组元素,columns 里的旧引用还指向旧对象,
    // NoteCard.props.note 不会感知到内容变化(典型症状: 三点菜单"编辑"保存后列表不刷新)。
    // Object.assign 保持引用同时更新字段,columns / NoteDetail / 任何持有该 ref 的地方都收到响应式更新。
    for (const k of Object.keys(_viewState) as ViewKey[]) {
      const vs = _viewState[k];
      const idx = vs.notes.findIndex((n) => n.id === id);
      if (idx >= 0) {
        Object.assign(vs.notes[idx], res.data);
        // type / category 改后跟当前 view 过滤不一致 → 从本地列表移除, 让卡片直接消失
        // (只对当前 activeView 做过滤判断, 其他 view 保留 — 切回后会自己 re-evaluate)
        if (k === activeView.value) {
          const typeMismatch = !!filterType.value && res.data.type !== filterType.value;
          const categoryMismatch = !!filterCategory.value && res.data.category !== filterCategory.value;
          if (typeMismatch || categoryMismatch) {
            vs.notes.splice(idx, 1);
            vs.total = Math.max(0, vs.total - 1);
          }
        }
      }
    }
    return res.data;
  }

  async function deleteNote(id: string) {
    await api.deleteNote(id);
    // 跨 view 同步删除: 所有 view 的本地 notes 移除该 id
    // 用 splice 而不是 filter 重新赋值: filter 创建新数组等于 reassign,会跟筛选/搜索的
    // notes = res.data 在 useMasonry 视角下混淆 —— 都是"length 减少 + 子集",
    // 误走 splice 优化让筛选结果留在原列。改 mutate 后,useMasonry 用 reassign 检测
    // 能精确区分两种场景: reassign=筛选(rebuild), mutate=删除(走原 splice 优化)
    for (const k of Object.keys(_viewState) as ViewKey[]) {
      const vs = _viewState[k];
      const idx = vs.notes.findIndex((n) => n.id === id);
      if (idx >= 0) {
        vs.notes.splice(idx, 1);
        vs.total = Math.max(0, vs.total - 1);
      }
    }
  }

  // 撤销删除: 调 restoreNote API + 把 snapshot unshift 回当前 view notes 顶端
  // (不重新 fetch, 保留 scroll/分页状态). 批量传 snapshots 数组, 一次性 unshift 让 useMasonry watch 只触发一次
  async function undoDelete(snapshots: Note[]): Promise<number> {
    const view = activeView.value;
    const restored: Note[] = [];
    for (const snap of snapshots) {
      try {
        await api.restoreNote(snap.id);
        restored.push(snap);
      } catch (e) {
        console.error('[undoDelete] failed for', snap.id, e);
      }
    }
    if (restored.length && view) {
      const vs = _viewState[view];
      vs.notes.unshift(...restored);
      vs.total += restored.length;
    }
    return restored.length;
  }

  async function togglePin(id: string) {
    const view = activeView.value;
    if (!view) return;
    const vs = _viewState[view];
    const note = vs.notes.find((n) => n.id === id);
    if (!note) return;
    const newPinned = !note.pinned;
    // 乐观更新: UI 立即反映 pinned 视觉(ring 边框/三点菜单文案),不等 API 往返
    note.pinned = newPinned;
    try {
      await updateNote(id, { pinned: newPinned });
      // 重拉让后端"按 pinned DESC 排序"生效(卡片位置变化);
      // 传 lastExtra 保留 tag/type/日期 等过滤条件,否则 fetchNotes() 会清掉过滤
      await fetchNotes(vs.lastExtra);
    } catch (e) {
      // 失败回滚乐观更新
      note.pinned = !newPinned;
      console.error('[togglePin] failed, rolled back:', e);
    }
  }

  // 底层: 批量把指定 id 的 todo 改成目标 status, 跳过 type!='todo' / 已是目标状态的;
  // 走本地 updateNote 包装 (Object.assign 字段 + 引用不变), pending/done 两个 computed 重算后
  // useMasonry 各自走 strict shrink splice / append 增量动画, 不需要 fetchNotes 重拉
  async function setTodoStatus(ids: string[], status: 'done' | 'pending'): Promise<number> {
    const view = activeView.value;
    if (!view) return 0;
    const vs = _viewState[view];
    const targets = ids
      .map((id) => vs.notes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => !!n && n.type === 'todo' && n.todoStatus !== status);
    if (!targets.length) return 0;
    await Promise.all(
      targets.map((n) => updateNote(n.id, { todoStatus: status } as any).catch((e) => console.error('[setTodoStatus]', n.id, e)))
    );
    return targets.length;
  }

  async function toggleTodo(id: string) {
    const view = activeView.value;
    if (!view) return;
    const vs = _viewState[view];
    const note = vs.notes.find((n) => n.id === id);
    if (!note || note.type !== 'todo') return;
    await setTodoStatus([id], note.todoStatus === 'done' ? 'pending' : 'done');
  }

  // 创建后轮询单条笔记的 AI 结果, 命中 aiProcessed=true 时 Object.assign 进所有 view 的本地引用
  // (mutate 不触发 useMasonry rebuild, NoteCard 通过 props deep watch 自动重渲染 tags/category/summary).
  // 退避序列 2/3/5/8/12s 累积 30s.
  async function pollNoteAiResult(id: string) {
    const delays = [2000, 3000, 5000, 8000, 12000];
    for (const d of delays) {
      await new Promise((r) => setTimeout(r, d));
      try {
        const res = await api.getNote(id);
        const fresh = res.data;
        if (fresh.aiProcessed) {
          for (const k of Object.keys(_viewState) as ViewKey[]) {
            const vs = _viewState[k];
            const idx = vs.notes.findIndex((n) => n.id === id);
            if (idx >= 0) Object.assign(vs.notes[idx], fresh);
          }
          return;
        }
      } catch (e) {
        console.error('[pollNoteAiResult]', id, e);
        return;
      }
    }
  }

  // 监听桌面端快捷输入保存事件: 带 detail.id 时走轻量轮询 patch 单条 (跟 NoteInput/MobileInput 同路径),
  // 不带 id 时回退到全量 fetchNotes (向后兼容老路径 / 未来扩展)
  if (typeof window !== 'undefined') {
    window.addEventListener('quink-note-created', (e: any) => {
      const id = e?.detail?.id;
      if (id) pollNoteAiResult(id);
      else fetchNotes();
    });
  }

  // ── 批量操作 ──
  const selectMode = ref(false);
  const selectedIds = ref<Set<string>>(new Set());

  function toggleSelectMode() {
    selectMode.value = !selectMode.value;
    if (!selectMode.value) selectedIds.value.clear();
  }

  function toggleSelect(id: string) {
    if (selectedIds.value.has(id)) selectedIds.value.delete(id);
    else selectedIds.value.add(id);
  }

  function selectAll() {
    for (const n of notes.value) selectedIds.value.add(n.id);
  }

  // 退多选模式: 一次批量操作完成后调用, 既清选中又退模式. 让 UI 回到正常视图, 避免操作完成后
  // 留在 "已选 0 项" 的空模式 (所有 batch 按钮变 no-op 看着 awkward). 拖动批量操作 (cardDnd /
  // Sidebar doTrash) 也走这条路径, 跟 batch 函数语义一致.
  function exitSelectMode() {
    selectMode.value = false;
    selectedIds.value.clear();
  }

  // 批量操作统一走 Promise.all 并发 + 失败 console.error (跟 Trash batch ops / Sidebar.doTrash 同模式)
  // 所有 batch 函数操作前调 exitSelectMode 让 UI 立即退出多选 (await 期间用户看到正常视图)
  async function batchDelete() {
    const ids = Array.from(selectedIds.value);
    exitSelectMode();
    await Promise.all(ids.map(id => api.deleteNote(id).catch(e => console.error('[batchDelete]', id, e))));
    await fetchNotes();
  }

  async function batchMove(category: string) {
    const ids = Array.from(selectedIds.value);
    exitSelectMode();
    await Promise.all(ids.map(id => api.updateNote(id, { category } as any).catch(e => console.error('[batchMove]', id, e))));
    await fetchNotes();
  }

  // 批量改 type: todoStatus 字段不动 (todo→snippet/note 时 DB 仍保留, 转回 todo 时复用)
  async function batchUpdateType(type: 'note' | 'snippet' | 'todo') {
    const ids = Array.from(selectedIds.value);
    exitSelectMode();
    await Promise.all(ids.map(id => api.updateNote(id, { type } as any).catch(e => console.error('[batchUpdateType]', id, e))));
    await fetchNotes();
  }

  // 批量改 todoStatus: 从 selectedIds 取 id 后复用 setTodoStatus, 返回实际改动数 (UI 用来显示 toast)
  async function batchSetTodoStatus(status: 'done' | 'pending'): Promise<number> {
    const ids = Array.from(selectedIds.value);
    exitSelectMode();
    return setTodoStatus(ids, status);
  }

  // 批量加标签: 合并到现有 tags (去重), 不覆盖
  async function batchAddTags(tagsToAdd: string[]) {
    if (!tagsToAdd.length) return;
    const view = activeView.value;
    const ids = Array.from(selectedIds.value);
    exitSelectMode();
    await Promise.all(ids.map(id => {
      const vs = view ? _viewState[view] : null;
      const note = vs?.notes.find(n => n.id === id);
      const existing = note?.tags || [];
      const merged = Array.from(new Set([...existing, ...tagsToAdd]));
      return api.updateNote(id, { tags: merged } as any).catch(e => console.error('[batchAddTags]', id, e));
    }));
    await fetchNotes();
  }

  return {
    notes,
    loading,
    total,
    currentPage,
    pageSize,
    activeView,
    getViewState,
    loadMore,
    searchQuery,
    filterCategory,
    filterType,
    isFiltering,
    fileCategory,
    fileDateFrom,
    fileDateTo,
    currentRefresh,
    sortBy,
    sortedNotes,
    groupedByDate,
    fetchNotes,
    createNote,
    pollNoteAiResult,
    updateNote,
    deleteNote,
    undoDelete,
    togglePin,
    toggleTodo,
    selectMode,
    selectedIds,
    toggleSelectMode,
    toggleSelect,
    selectAll,
    exitSelectMode,
    batchDelete,
    batchMove,
    batchUpdateType,
    batchSetTodoStatus,
    batchAddTags,
  };
});
