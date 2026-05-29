import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api, type Note } from '@/api';

export const useNotesStore = defineStore('notes', () => {
  const notes = ref<Note[]>([]);
  const loading = ref(false);
  const total = ref(0);
  const currentPage = ref(1);
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

  // Sorted notes
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

  // 记住上次 fetchNotes 的 extra 参数,loadMore 时复用(否则 tag 过滤后翻页会丢失过滤条件)
  let lastExtra: { tag?: string; tags?: string; types?: string; dateFrom?: string; dateTo?: string } | undefined = undefined;

  async function fetchNotes(
    extra?: { tag?: string; tags?: string; types?: string; dateFrom?: string; dateTo?: string },
    opts: { append?: boolean } = {}
  ) {
    // 非 append (首次/换 filter/换 view) → 重置到第 1 页
    if (!opts.append) {
      currentPage.value = 1;
      lastExtra = extra;
    }
    loading.value = true;
    try {
      const params: Record<string, string> = {
        page: String(currentPage.value),
        limit: String(pageSize.value),
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
        const existing = new Set(notes.value.map(n => n.id));
        const newOnes = res.data.filter(n => !existing.has(n.id));
        // 用 push() 追加到现有数组,不替换 ref —— 否则 TransitionGroup 把整个数组视为新引用,
        // 重建所有 DOM 节点导致容器短暂塌缩,滚动位置回到顶部
        notes.value.push(...newOnes);
      } else {
        notes.value = res.data;
      }
      total.value = res.pagination.total;
    } finally {
      loading.value = false;
    }
  }

  async function loadMore() {
    if (loading.value || notes.value.length >= total.value) return;
    currentPage.value++;
    await fetchNotes(lastExtra, { append: true });
  }

  async function createNote(content: string, type: string = 'note', tags?: string[]) {
    const res = await api.createNote({ content, type, tags });
    // 后端按 pinned DESC, updated_at DESC 排, 新非置顶笔记直接插到所有置顶之后的第一位.
    // 后续 pollNoteAiResult 走 mutate Object.assign 不重排, 初始位置就是最终位置 ── 否则
    // unshift 到 [0] 会先 "比置顶还前", 视觉上需要等到下一次全量 fetchNotes 才修正.
    // reassign 数组 (而非 splice mutate) 让 useMasonry 走 reassign rebuild 全量重排;
    // 不能用 splice mutate ── useMasonry append 路径假定新元素在末尾, 会拿错卡片 (composables/CLAUDE.md 坑 6)
    const insertIdx = notes.value.findIndex((n) => !n.pinned);
    const next = [...notes.value];
    if (insertIdx === -1) next.push(res.data);
    else next.splice(insertIdx, 0, res.data);
    notes.value = next;
    total.value++;
    return res.data;
  }

  async function updateNote(id: string, data: Partial<Note>) {
    const res = await api.updateNote(id, data);
    // mutate 字段而非替换引用: useMasonry 的 columns 里存的是 notes 元素引用,
    // 用 notes.value[idx] = newObj 替换数组元素,columns 里的旧引用还指向旧对象,
    // NoteCard.props.note 不会感知到内容变化(典型症状: 三点菜单"编辑"保存后列表不刷新)。
    // Object.assign 保持引用同时更新字段,columns / NoteDetail / 任何持有该 ref 的地方都收到响应式更新。
    const idx = notes.value.findIndex((n) => n.id === id);
    if (idx >= 0) {
      Object.assign(notes.value[idx], res.data);
      // type / category 改后跟当前 view 过滤不一致 → 从本地列表移除, 让卡片直接消失 (用户视觉清晰: 移走了的卡片不留在原页面)
      const typeMismatch = !!filterType.value && res.data.type !== filterType.value;
      const categoryMismatch = !!filterCategory.value && res.data.category !== filterCategory.value;
      if (typeMismatch || categoryMismatch) {
        notes.value.splice(idx, 1);
        total.value = Math.max(0, total.value - 1);
      }
    }
    return res.data;
  }

  async function deleteNote(id: string) {
    await api.deleteNote(id);
    // 用 splice 而不是 filter 重新赋值: filter 创建新数组等于 reassign,会跟筛选/搜索的
    // notes.value = res.data 在 useMasonry 视角下混淆 —— 都是"length 减少 + 子集",
    // 误走 splice 优化让筛选结果留在原列。改 mutate 后,useMasonry 用 reassign 检测
    // 能精确区分两种场景: reassign=筛选(rebuild), mutate=删除(走原 splice 优化)
    const idx = notes.value.findIndex((n) => n.id === id);
    if (idx >= 0) notes.value.splice(idx, 1);
    total.value = Math.max(0, total.value - 1);
  }

  // 撤销删除: 调 restoreNote API + 把 snapshot unshift 回 notes 顶端 (不重新 fetch, 保留 scroll/分页状态)
  // 批量传 snapshots 数组, 一次性 unshift 让 useMasonry watch 只触发一次
  async function undoDelete(snapshots: Note[]): Promise<number> {
    const restored: Note[] = [];
    for (const snap of snapshots) {
      try {
        await api.restoreNote(snap.id);
        restored.push(snap);
      } catch (e) {
        console.error('[undoDelete] failed for', snap.id, e);
      }
    }
    if (restored.length) {
      notes.value.unshift(...restored);
      total.value += restored.length;
    }
    return restored.length;
  }

  async function togglePin(id: string) {
    const note = notes.value.find((n) => n.id === id);
    if (!note) return;
    const newPinned = !note.pinned;
    // 乐观更新: UI 立即反映 pinned 视觉(ring 边框/三点菜单文案),不等 API 往返
    note.pinned = newPinned;
    try {
      await updateNote(id, { pinned: newPinned });
      // 重拉让后端"按 pinned DESC 排序"生效(卡片位置变化);
      // 传 lastExtra 保留 tag/type/日期 等过滤条件,否则 fetchNotes() 会清掉过滤
      await fetchNotes(lastExtra);
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
    const targets = ids
      .map((id) => notes.value.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => !!n && n.type === 'todo' && n.todoStatus !== status);
    if (!targets.length) return 0;
    await Promise.all(
      targets.map((n) => updateNote(n.id, { todoStatus: status } as any).catch((e) => console.error('[setTodoStatus]', n.id, e)))
    );
    return targets.length;
  }

  async function toggleTodo(id: string) {
    const note = notes.value.find((n) => n.id === id);
    if (!note || note.type !== 'todo') return;
    await setTodoStatus([id], note.todoStatus === 'done' ? 'pending' : 'done');
  }

  // 创建后轮询单条笔记的 AI 结果, 命中 aiProcessed=true 时 Object.assign 进本地引用 (mutate 不触发 useMasonry rebuild,
  // NoteCard 通过 props deep watch 自动重渲染 tags/category/summary).
  // 退避序列 2/3/5/8/12s 累积 30s: 云端 API 1-3s 第一轮大概率命中, 本地 Ollama 3-30s 第二三轮命中, 超 30s 静默放弃.
  // 失败 (404 / 网络) 即停, 不重试, 避免被删除的笔记一直轮询.
  async function pollNoteAiResult(id: string) {
    const delays = [2000, 3000, 5000, 8000, 12000];
    for (const d of delays) {
      await new Promise((r) => setTimeout(r, d));
      try {
        const res = await api.getNote(id);
        const fresh = res.data;
        if (fresh.aiProcessed) {
          const idx = notes.value.findIndex((n) => n.id === id);
          if (idx >= 0) Object.assign(notes.value[idx], fresh);
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
    const ids = Array.from(selectedIds.value);
    exitSelectMode();
    await Promise.all(ids.map(id => {
      const note = notes.value.find(n => n.id === id);
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
    loadMore,
    searchQuery,
    filterCategory,
    filterType,
    isFiltering,
    fileCategory,
    fileDateFrom,
    fileDateTo,
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
