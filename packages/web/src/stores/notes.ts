import { defineStore } from 'pinia';
import { ref, shallowRef, computed, reactive, watch } from 'vue';
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
  // 跨 view 操作的脏标记: updateNote 改 type 把笔记搬到另一个 view 时, 不直接 reassign
  // 后台 view 的 notes (KeepAlive 缓存的 view DOM 已 detach → useMasonry rebuild 拿不到
  // 真实卡片高度 → 全走 estimateHeight 偏低 → pickShortest 错把所有卡塞同列). 改打 dirty,
  // 目标 view 下次 onActivated 时走 keepCount fetch 同步.
  dirty?: boolean;
  // 笔记 scope (语义: private 笔记始终显示, sharedDisplay 偏好控制纳入哪些群组共享笔记):
  //   mine          = 作者本人全部 (private + 我分享出去的 shared, 偏好 'own', 默认)
  //   private       = 仅 private (偏好 'none', 排除任何 shared)
  //   others_shared = 我的 private + 他人共享给我所在群的 shared (偏好 'others', 排除我分享出去的 shared)
  //   shared        = 遗留字段, 仅他人 shared (不含我的 private), 偏好不映射到此, 保留兼容旧 API
  //   all           = mine + 他人共享给我所在群的 shared (偏好 'all')
  // 群 feed 不走这里, GroupDetail 内 local ref 自管.
  scope?: 'mine' | 'private' | 'others_shared' | 'shared' | 'all';
}

// sharedDisplay 偏好 → 后端 scope 映射. Settings 改 sharedDisplay → store watch 推到各 view vs.scope.
// 4 个值跟 UI 4 个选项一一对应 (own=仅我发布的 / others=仅他人发布的 / none=全部隐藏 / all=全部显示)
const SHARED_DISPLAY_TO_SCOPE = {
  own: 'mine',
  others: 'others_shared',
  none: 'private',
  all: 'all',
} as const;
type SharedDisplay = keyof typeof SHARED_DISPLAY_TO_SCOPE;

function createInitState(): ViewState {
  return { notes: [], total: 0, currentPage: 1, scrollTop: 0, lastExtra: undefined, dirty: false, scope: 'mine' };
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
  // 跨视图跳转筛选的一次性传递 (Tags 点标签 / Stats 热力图点日期 → 灵感页). 走 store 不走 url query,
  // 避免筛选进网址 → 清筛选后刷新又被 query 重新应用. 灵感页 onActivated 消费后立即清空.
  const pendingTagFilter = ref('');
  const pendingDateFilter = ref('');
  // 是否有用户主动的筛选 (搜索/分类/标签/类型/日期)。由 TopBar watchEffect 写入,
  // 各 view 用它隐藏顶部 NoteInput 编辑区,避免筛选状态下还让用户新写笔记
  const isFiltering = ref(false);
  const sortBy = ref<'created' | 'updated'>('created');
  // 排序变化 → server ORDER BY 跟着变, 但 fetchNotes 的 keepCount mutate 路径会保旧 vs.notes 顺序
  // (mutate 只更新字段不重排). 修法: 清所有 view 的 notes/total/page, 各 view 下次 onActivated 走
  // wasEmpty 分支 fetchNotes() reset 拉新顺序. 不立即触发 fetch: 改 sortBy 时用户通常在 Settings 页,
  // 3 主 view 在 KeepAlive 后台 DOM detach 状态, detach 下 useMasonry measureCardHeights 拿不到真实
  // 高度 → pickShortest 错塞同列. 等切回时 DOM attach 走 wasEmpty 拉数据 + rebuild 才正常.
  watch(sortBy, () => {
    for (const v of Object.values(_viewState)) {
      v.notes = [];
      v.total = 0;
      v.currentPage = 1;
      v.dirty = false;
    }
  });
  // 主页共享笔记显示策略: Settings 改 sharedDisplay → 推到这里 → watch 更新各 view scope + 清缓存,
  // 切回主 view 时 onActivated wasEmpty 走 reset 拉新 scope 数据. 跟 sortBy 同款套路 (用户没打开过 Settings
  // 时 store 保持 'own' 默认值 = mine scope, 跟历史行为完全一致)
  const sharedDisplay = ref<SharedDisplay>('own');
  watch(sharedDisplay, (v) => {
    const newScope = SHARED_DISPLAY_TO_SCOPE[v];
    for (const vs of Object.values(_viewState)) {
      vs.notes = [];
      vs.total = 0;
      vs.currentPage = 1;
      vs.dirty = false;
      vs.scope = newScope;
    }
  });
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

  // fetch 覆盖 store 时保留 local 更新的 note (防 hover-navigate 触发的 fetch 拿到 stale version 覆盖已 updateNote 完成的.
  // 场景: cardDnd 拖卡 hover 切 view → 新 view mount fetchNotes 跟 drop 的 updateNote 并发, fetch 返回时 backend
  // 可能还没 apply update, 拿旧 version=5. 若 fetch 之后完成, 会用 stale 5 覆盖已经 Object.assign 更新的 store version=6.
  // 结果 second drop 用 stale version 撞 version_conflict. 逐条比较 version, local 更新的保留)
  function mergeKeepNewer(fresh: Note[], local: Note[]): Note[] {
    const localMap = new Map(local.map(n => [n.id, n]));
    return fresh.map(f => {
      const l = localMap.get(f.id);
      return l && (l.version || 0) > (f.version || 0) ? l : f;
    });
  }

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
      vs.dirty = false;
    } else if (opts.keepCount) {
      // refresh 保留 lastExtra,避免丢过滤条件(refresh() 通常不传 extra)
      extra = vs.lastExtra;
      vs.dirty = false;
    }
    loading.value = true;
    try {
      // keepCount limit 加 buffer (+20): server 可能有"别处新增"的 id (跨 view 改 type / 多设备 /
      // Capture), 不加 buffer 时 limit=本地条数, server 按 updated_at DESC 把新条目排前, 原本第
      // (length-N+1)..length 位的旧条目就被截掉, freshMap 没它们 → 误删. buffer 20 覆盖一次操作几条
      // 的常见量, 极端批量新增 (一次同步 30+) 不管, 走下次 onActivated reset.
      const limit = opts.keepCount
        ? Math.max(pageSize.value, vs.notes.length + 20)
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
      // 排序字段 (created 默认, updated = 按最后编辑时间). Settings 偏好驱动, 改后 watch(sortBy) 清缓存
      // 让各 view onActivated 走 wasEmpty 分支重新 fetch (server 真正按时间字段 ORDER BY 排好返回)
      if (sortBy.value === 'updated') params.sort = 'updated';
      // scope: 由 sharedDisplay 偏好 watch 推到 vs.scope, mine 默认不传 (server 也默认 mine)
      if (vs.scope && vs.scope !== 'mine') params.scope = vs.scope;

      const res = await api.getNotes(params);
      if (opts.append) {
        // 去重:服务端分页边界可能有重叠,id 已存在的跳过
        const existing = new Set(vs.notes.map(n => n.id));
        const newOnes = res.data.filter(n => !existing.has(n.id));
        // 用 push() 追加到现有数组,不替换 ref —— 否则 TransitionGroup 把整个数组视为新引用,
        // 重建所有 DOM 节点导致容器短暂塌缩,滚动位置回到顶部
        vs.notes.push(...newOnes);
      } else if (opts.keepCount) {
        // 两条路径:
        //   无新增 → mutate (更新现有字段 + 删消失的), useMasonry 走 splice 优化, 卡片零移动 diff=0.
        //   有新增 → reassign 走 server 顺序(pinned DESC, updated_at DESC), useMasonry rebuild.
        //     代价: 部分卡可能跨列移动(rebuild pickShortest 重新选最矮列, 即使用真实高度也可能
        //     跟原列不同, 实测 diff=89). trade-off: 比"新条目排在末尾脱离时间顺序"对用户更对.
        //     onActivated 触发时 DOM 已 attach, measureCardHeights 拿到真实高度 → 不会出现
        //     "全走 estimateHeight 把所有卡塞同列"的错乱.
        const freshMap = new Map(res.data.map(n => [n.id, n]));
        const localIds = new Set(vs.notes.map(n => n.id));
        const hasNewIds = res.data.some(n => !localIds.has(n.id));
        if (hasNewIds) {
          vs.notes = mergeKeepNewer(res.data, vs.notes);
        } else {
          // 删消失的 id (从尾往前 splice 防 index 漂移)
          for (let i = vs.notes.length - 1; i >= 0; i--) {
            if (!freshMap.has(vs.notes[i].id)) vs.notes.splice(i, 1);
          }
          // 更新现有 id 字段 (Object.assign 保引用, NoteCard props deep watch 拿到新值)
          for (const note of vs.notes) {
            const fresh = freshMap.get(note.id);
            if (fresh) Object.assign(note, fresh);
          }
        }
      } else {
        vs.notes = mergeKeepNewer(res.data, vs.notes);
      }
      vs.total = res.pagination.total;
      if (opts.keepCount) {
        // 重算 currentPage 让 loadMore 接得上:已加载 90 条 pageSize 30 → currentPage=3,
        // 下次 loadMore 拉 page=4. 用 vs.notes.length (mutate 后实际剩余) 而非 res.data.length
        vs.currentPage = Math.max(1, Math.ceil(vs.notes.length / pageSize.value));
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

  // type → 对应 view 的映射 (quink=灵感, note=笔记, todo=待办)
  const typeToView: Record<string, ViewKey> = {
    quink: 'inspiration',
    note: 'notes',
    todo: 'todos',
  };

  // createNote 加 visibility + sharedGroupIds 透传给 server
  // category: null = 走 AI 自动分类 (后端 autoClassify 仅在 category 为 null 时回填); 非空 = 用户手动选过, 保护不被 AI 覆盖
  async function createNote(content: string, type: string = 'quink', tags?: string[], visibility: 'private' | 'shared' = 'private', sharedGroupIds: string[] = [], category: string | null = null, todoOpts?: { todoGroupMode?: 'group' | 'everyone'; rosterDueAt?: string | null; rosterVisibility?: 'count' | 'full' | 'none' }) {
    const res = await api.createNote({ content, type, tags, visibility, sharedGroupIds, category: category ?? undefined, ...todoOpts });
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

  // 远端笔记变化时同步主 view (SSE group-notes-changed handler 调). 当前 view 是 3 主 view 之一
  // (sharedDisplay='all'/'others_shared' 时主 view 会显示别人共享的笔记) → fetchNotes keepCount 拉新数据;
  // 跨 view 全部标 dirty 让下次 onActivated 走 viewRefresh 同步.
  function refreshFromRemote() {
    if (activeView.value) {
      void fetchNotes(undefined, { keepCount: true });
    }
    for (const k of Object.keys(_viewState) as ViewKey[]) {
      if (k !== activeView.value) _viewState[k].dirty = true;
    }
  }

  async function updateNote(id: string, data: Partial<Note> & { lockToken?: string; editContext?: { groupId?: string }; skipTimestamp?: boolean }) {
    // 自动注入 version 兜底: 所有笔记 (private / shared) 改内容字段时后端必须校验 version 防多设备旧覆盖新.
    // NoteEditModal 已显式传 version, 这里给 NoteCard 切待办 / NoteDetail 改 type / cardDnd 拖改类型分类 等其它入口兜底, 调用方不用每处都加.
    // 找不到 cached note (NoteDetail 通过 URL 直接打开未入 store 的极少数 case) → 不注入, 调用方该场景需自己传 version
    if (data.version === undefined) {
      const isContentChange = data.content !== undefined || data.summary !== undefined ||
        data.category !== undefined || data.tags !== undefined || data.type !== undefined ||
        data.todoStatus !== undefined;
      if (isContentChange) {
        for (const k of Object.keys(_viewState) as ViewKey[]) {
          const cached = _viewState[k].notes.find((n) => n.id === id);
          if (cached) {
            data = { ...data, version: cached.version || 1 };
            break;
          }
        }
      }
    }
    const res = await api.updateNote(id, data);
    // GroupDetail 用本地 ref 自管群笔记 (群 feed 不走 store), store 同步走不到那.
    // 从群组上下文改 (editContext.groupId 存在) → 派事件让 GroupDetail 重拉 feed, fork / in-place 路径都要派
    // (作者 in-place 改自己笔记 + 非作者 fork 改别人笔记都从群组页触发, 同款需求). 跟 NoteCard 改群内置顶同款事件.
    const ctxGroupId = data.editContext?.groupId;
    function notifyGroupReload() {
      if (ctxGroupId) {
        window.dispatchEvent(new CustomEvent('quink-group-notes-changed', { detail: { groupId: ctxGroupId } }));
      }
    }
    // COW fork 路径 (非作者改 shared / 作者从群组页改 root 多群 → 后端 fork 写入).
    // 此时 res.data 是新 fork note (新 id), 老 note 仍存在 (note_shares 仅去掉 ctxGroupId, 其它群保留).
    // in-place mutate 无法同步: 老 note 字段可能也变 (note_shares 少了一项), 新 fork 不在任一 view local cache 里.
    // 解决: 当前 view 走 fetchNotes keepCount 拉权威数据, 跨 view 标 dirty 下次 onActivated 同步.
    if (res.forked) {
      if (activeView.value) {
        await fetchNotes(undefined, { keepCount: true });
      }
      for (const k of Object.keys(_viewState) as ViewKey[]) {
        if (k !== activeView.value) _viewState[k].dirty = true;
      }
      notifyGroupReload();
      return res.data;
    }
    // 改字段同步到所有 view 的本地 notes 副本. 4 种情境对称处理 (源 / 目标 × 当前 / 后台):
    //   源 view 当前 = 普通改 (Object.assign + 可能 splice 过滤 / sortBy 重排)
    //   源 view 后台 + 跨 view 搬走 (k !== targetViewKey) = 不动 vs.notes 只标 dirty
    //       原因: Object.assign 改字段会让 view 内 filter-based computed (如 Todos 的
    //       pendingTodos = vs.notes.filter(type==='todo')) 重算返回新数组 → useMasonry watch
    //       newItems !== oldItems → rebuild → KeepAlive 后台 DOM detached → measureCardHeights
    //       拿空 → 全 estimateHeight 偏低 → pickShortest 塞同一列 (跟昨天目标 view detached
    //       reassign 是镜像 bug, 在 hover navigate 把源 view 切到后台时触发).
    //   源 view 后台 + 仍归属此 view (改非 type 字段) = Object.assign 更新, 接受 latent rebuild 风险
    //       (filter computed 重算虽然 ids 不变但返回新引用仍触发 rebuild, 实际 Inspiration/Notes 直传
    //       vs.notes 不走 filter computed 不受影响, Todos 这条 latent 路径靠下次 onActivated 兜底)
    //   目标 view 当前 (hover navigate 跳过来后落地) = 直接插入"置顶之后第一位" (仿 createNote)
    //       让用户立刻看到新条目, DOM attached useMasonry rebuild 用真实高度正常.
    //   目标 view 后台 (传统拖法 / 编辑器改 type) = 标 dirty, 下次 onActivated 走 viewRefresh.
    const targetViewKey = typeToView[res.data.type];
    let foundInTargetView = false;
    for (const k of Object.keys(_viewState) as ViewKey[]) {
      const vs = _viewState[k];
      const idx = vs.notes.findIndex((n) => n.id === id);
      if (idx < 0) continue;
      // 源 view 后台 + 跨 view 搬走: 防 detached rebuild 塞同列 bug, 不动数据 + 标 dirty 让下次激活时 viewRefresh 同步
      if (k !== activeView.value && k !== targetViewKey) {
        vs.dirty = true;
        continue;
      }
      Object.assign(vs.notes[idx], res.data);
      if (k === targetViewKey) foundInTargetView = true;
      if (k === activeView.value) {
        // type / category 改后跟当前 view 过滤不一致 → 移除, 卡片消失
        const typeMismatch = !!filterType.value && res.data.type !== filterType.value;
        // sentinel '__uncategorized__' 匹配 category 为 null 的笔记; 普通字符串走严格等
        const categoryMismatch = filterCategory.value === '__uncategorized__'
          ? res.data.category !== null
          : !!filterCategory.value && res.data.category !== filterCategory.value;
        if (typeMismatch || categoryMismatch) {
          vs.notes.splice(idx, 1);
          vs.total = Math.max(0, vs.total - 1);
          continue;
        }
        // 按编辑时间排序时编辑后笔记飞到"置顶之后第一位" 匹配 server ORDER BY (updated_at DESC)
        // skipTimestamp (任务清单 checkbox toggle) 不更新 updatedAt → 也不该把笔记搬到最前
        if (sortBy.value === 'updated' && !res.data.pinned && idx > 0 && !data.skipTimestamp) {
          const note = vs.notes[idx];
          vs.notes.splice(idx, 1);
          const insertIdx = vs.notes.findIndex((n) => !n.pinned);
          if (insertIdx === -1) vs.notes.push(note);
          else vs.notes.splice(insertIdx, 0, note);
        }
      }
    }
    // 目标 view 不持有这条 (跨 view 改 type 落地)
    if (targetViewKey && !foundInTargetView) {
      const targetVs = _viewState[targetViewKey];
      if (targetViewKey === activeView.value) {
        // hover navigate 跳来后用户在目标 view 落地: 直接插入"置顶之后第一位", reassign 让 useMasonry
        // rebuild (前台 DOM attached, measureCardHeights 拿真实高度 → 正常分列). 跟 createNote 同路径.
        const insertIdx = targetVs.notes.findIndex((n) => !n.pinned);
        const next = [...targetVs.notes];
        if (insertIdx === -1) next.push(res.data);
        else next.splice(insertIdx, 0, res.data);
        targetVs.notes = next;
        targetVs.total = (targetVs.total || 0) + 1;
      } else {
        // 传统拖法 / 编辑器改 type: 目标 view 后台, 标 dirty, 下次 onActivated 走 viewRefresh.
        targetVs.dirty = true;
      }
    }
    notifyGroupReload();
    return res.data;
  }

  async function deleteNote(id: string, opts?: { groupId?: string }) {
    // groupId 可选, admin 删别人共享笔记时从群组上下文传, 后端写 deletedInGroupId 进群回收站
    const res = await api.deleteNote(id, opts);
    // 删共享笔记后给每个所在群派 quink-group-notes-changed 让操作者自己的 GroupDetail 重拉
    // (GroupDetail 用本地 ref 自管收不到自己的 SSE; 别人通过后端 broadcastNoteShared 收 SSE 已自动刷)
    for (const gid of res.sharedGroupIds ?? []) {
      window.dispatchEvent(new CustomEvent('quink-group-notes-changed', { detail: { groupId: gid } }));
    }
    // 跨 view 同步删除:
    //   前台 view: splice 移除 id (DOM attached, useMasonry 走 shrunk 增量删除 line 158-189 安全).
    //     注意必须 splice mutate 不能 filter reassign — filter 创建新数组等于 reassign, useMasonry
    //     会跟筛选/搜索的 `notes = res.data` 混淆 (都是"length 减少 + 子集") → 误走 splice 优化让
    //     筛选结果留在原列。mutate 后 reassign=筛选(rebuild) / mutate=删除(splice 优化) 能精确区分。
    //   后台 view: 标 dirty 不动数据 (跟 updateNote / syncFreshToViewStates 同根因 — 避开 Todos
    //     filter computed 重算触发 useMasonry rebuild 在 detached DOM 上塞同列). 下次 onActivated
    //     viewRefresh 走 fetchNotes keepCount 自动 splice 删除已不存在的 id, 那时 DOM 可达安全.
    for (const k of Object.keys(_viewState) as ViewKey[]) {
      const vs = _viewState[k];
      const idx = vs.notes.findIndex((n) => n.id === id);
      if (idx < 0) continue;
      if (k === activeView.value) {
        vs.notes.splice(idx, 1);
        vs.total = Math.max(0, vs.total - 1);
      } else {
        vs.dirty = true;
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

  // 每人完成待办: 把某条的最新完成进度同步到所有 viewState 的本地副本 (NoteCard onToggleTodoDone 调).
  // 解决"群组界面点完成 → 个人列表 Todos 不刷新": 群组界面 props.note 是 GroupDetail 本地 ref 不在 store,
  // NoteCard 自己 mutate 它即时; 这里补同步 store viewState (Todos 切回时已是新进度, 不用手动刷新). 保留各自本地 roster.
  function syncTodoDone(noteId: string, summary: { completed: number; total: number; mine: boolean; groupDone: boolean }) {
    for (const k of Object.keys(_viewState) as ViewKey[]) {
      const n = _viewState[k].notes.find((x) => x.id === noteId);
      if (n) n.todoDoneSummary = { ...summary, roster: n.todoDoneSummary?.roster, hideProgress: n.todoDoneSummary?.hideProgress };
    }
  }

  // 把 GET /api/notes/:id 拿到的最新数据同步到所有 view 的本地副本.
  // 前台 view (activeView): Object.assign 保引用更新, NoteCard props deep watch 重渲染.
  // 后台 view: 不动 vs.notes 只标 dirty, 下次 onActivated 走 viewRefresh 同步.
  //   原因: deep mutation 让 view 内 filter-based computed (Todos.vue 的 pendingTodos =
  //   vs.notes.filter(type==='todo')) 重算返回新数组 → useMasonry watch newItems !== oldItems
  //   → rebuild → KeepAlive 后台 DOM detached → measureCardHeights 拿空 → estimateHeight
  //   偏低 → pickShortest 塞同一列. 跟 updateNote 4-case 对称化同根因, 详见 packages/web/CLAUDE.md.
  function syncFreshToViewStates(id: string, fresh: Note) {
    for (const k of Object.keys(_viewState) as ViewKey[]) {
      const vs = _viewState[k];
      const idx = vs.notes.findIndex((n) => n.id === id);
      if (idx < 0) continue;
      if (k === activeView.value) {
        Object.assign(vs.notes[idx], fresh);
      } else {
        vs.dirty = true;
      }
    }
  }

  // SSE 收到 note-updated 时调 (scheduler 触发提醒后端更新 todoDue/todoRemindSentAt, 前端立刻反映).
  // 加 fallback - 所有 viewState 都没该 id 时走 syncNoteCreated 按 type 插入 (群回收站 restore 后笔记从 trash 出来, 原作者主 view 之前没这条)
  async function refreshSingleNote(id: string) {
    try {
      const res = await api.getNote(id);
      const inSomeView = Object.values(_viewState).some(vs => vs.notes.some(n => n.id === id));
      if (!inSomeView) {
        await syncNoteCreated(id);
        return;
      }
      syncFreshToViewStates(id, res.data);
    } catch (e) {
      console.error('[refreshSingleNote]', id, e);
    }
  }

  // SSE 收到 note-created 时调 (POST /notes 或 trash restore 后, 给作者本人所有设备多设备同步).
  // 拉单条 + 按 type 插入对应 viewState. 已存在 (本设备发起 POST 后又收到自己发的 SSE, 或并发多次创建) → 跳过插入只走更新.
  async function syncNoteCreated(id: string) {
    try {
      const res = await api.getNote(id);
      const note = res.data;
      const targetViewKey = typeToView[note.type];
      if (!targetViewKey) return;
      const vs = _viewState[targetViewKey];
      const existIdx = vs.notes.findIndex((n) => n.id === id);
      if (existIdx >= 0) {
        // 已存在 → 走更新 (本设备发起或 race), Object.assign 字段保引用
        syncFreshToViewStates(id, note);
        return;
      }
      if (targetViewKey === activeView.value) {
        // 目标 view 是当前 view → 插入到"首位 after pinned" (跟 createNote 同款逻辑)
        const insertIdx = vs.notes.findIndex((n) => !n.pinned);
        const next = [...vs.notes];
        if (insertIdx === -1) next.push(note);
        else next.splice(insertIdx, 0, note);
        vs.notes = next;
        vs.total++;
      } else {
        // 目标 view 是后台 → 标 dirty 下次 onActivated 时 viewRefresh 同步
        vs.dirty = true;
      }
    } catch (e) {
      console.error('[syncNoteCreated]', id, e);
    }
  }

  // SSE 收到 note-deleted 时调 (DELETE /:id 软删 或 DELETE /trash/:id 彻底删除后, 给作者本人所有设备同步).
  // 不调 API (会再 DELETE 一次), 只本地从所有 viewState 移除该 id. 跟 deleteNote 后半段同款 (前台 splice / 后台 dirty)
  function syncNoteDeleted(id: string) {
    for (const k of Object.keys(_viewState) as ViewKey[]) {
      const vs = _viewState[k];
      const idx = vs.notes.findIndex((n) => n.id === id);
      if (idx < 0) continue;
      if (k === activeView.value) {
        vs.notes.splice(idx, 1);
        vs.total = Math.max(0, vs.total - 1);
      } else {
        vs.dirty = true;
      }
    }
  }

  // SSE 收到 trash-cleared 时调 (DELETE /trash 清空回收站后多设备同步).
  // 简化: 标所有 view dirty 让下次 onActivated 走 viewRefresh. Trash view 用本地 ref 单独监听 quink-trash-cleared CustomEvent
  function syncTrashCleared() {
    for (const k of Object.keys(_viewState) as ViewKey[]) {
      _viewState[k].dirty = true;
    }
  }

  // 创建后轮询单条笔记的 AI 结果, 命中 aiProcessed=true 时同步进所有 view.
  // 退避序列 2/3/5/8/12s 累积 30s.
  async function pollNoteAiResult(id: string) {
    const delays = [2000, 3000, 5000, 8000, 12000];
    for (const d of delays) {
      await new Promise((r) => setTimeout(r, d));
      try {
        const res = await api.getNote(id);
        const fresh = res.data;
        if (fresh.aiProcessed) {
          syncFreshToViewStates(id, fresh);
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
  // 返回 { ok, skipped } 让调用方 toast 区分成功/无权限. 群管理员多选含别人笔记时
  // 后端按字段权限筛 (PATCH 守卫剥字段 / DELETE 仅作者+admin), 失败的算 skipped
  type BatchResult = { ok: number; skipped: number };
  async function settleBatch<T>(ids: string[], runner: (id: string) => Promise<T>): Promise<BatchResult> {
    let ok = 0, skipped = 0;
    await Promise.all(ids.map(id => runner(id).then(
      () => { ok++; },
      (e) => { console.error('[batch]', id, e); skipped++; },
    )));
    return { ok, skipped };
  }

  async function batchDelete(): Promise<BatchResult> {
    const ids = Array.from(selectedIds.value);
    exitSelectMode();
    const r = await settleBatch(ids, id => api.deleteNote(id));
    await fetchNotes();
    return r;
  }

  async function batchMove(category: string): Promise<BatchResult> {
    const ids = Array.from(selectedIds.value);
    exitSelectMode();
    const r = await settleBatch(ids, id => api.updateNote(id, { category } as any));
    await fetchNotes();
    return r;
  }

  // 批量改 type: todoStatus 字段不动 (todo→snippet/note 时 DB 仍保留, 转回 todo 时复用)
  async function batchUpdateType(type: 'quink' | 'note' | 'todo'): Promise<BatchResult> {
    const ids = Array.from(selectedIds.value);
    exitSelectMode();
    const r = await settleBatch(ids, id => api.updateNote(id, { type } as any));
    await fetchNotes();
    return r;
  }

  // 批量改 todoStatus: 从 selectedIds 取 id 后复用 setTodoStatus, 返回实际改动数 (UI 用来显示 toast)
  async function batchSetTodoStatus(status: 'done' | 'pending'): Promise<number> {
    const ids = Array.from(selectedIds.value);
    exitSelectMode();
    return setTodoStatus(ids, status);
  }

  // 批量加标签: 合并到现有 tags (去重), 不覆盖
  async function batchAddTags(tagsToAdd: string[]): Promise<BatchResult> {
    if (!tagsToAdd.length) return { ok: 0, skipped: 0 };
    const view = activeView.value;
    const ids = Array.from(selectedIds.value);
    exitSelectMode();
    const r = await settleBatch(ids, id => {
      const vs = view ? _viewState[view] : null;
      const note = vs?.notes.find(n => n.id === id);
      const existing = note?.tags || [];
      const merged = Array.from(new Set([...existing, ...tagsToAdd]));
      return api.updateNote(id, { tags: merged } as any);
    });
    await fetchNotes();
    return r;
  }

  // 账号切换时清空 (auth clearUserData 调): 三个 view 笔记 + 筛选/多选/文件筛选, sortBy/sharedDisplay 复位默认
  // (新账号 applyUserPreferences 会重设这两个偏好)
  function reset() {
    for (const k of Object.keys(_viewState) as ViewKey[]) {
      Object.assign(_viewState[k], createInitState());
    }
    activeView.value = '';
    searchQuery.value = '';
    filterCategory.value = '';
    filterType.value = '';
    isFiltering.value = false;
    fileCategory.value = 'all';
    fileDateFrom.value = '';
    fileDateTo.value = '';
    selectMode.value = false;
    selectedIds.value = new Set();
    sortBy.value = 'created';
    sharedDisplay.value = 'own';
  }

  return {
    reset,
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
    pendingTagFilter,
    pendingDateFilter,
    isFiltering,
    fileCategory,
    fileDateFrom,
    fileDateTo,
    currentRefresh,
    sortBy,
    sharedDisplay,
    refreshFromRemote,
    fetchNotes,
    createNote,
    pollNoteAiResult,
    refreshSingleNote,
    syncNoteCreated,
    syncNoteDeleted,
    syncTrashCleared,
    updateNote,
    deleteNote,
    undoDelete,
    togglePin,
    toggleTodo,
    syncTodoDone,
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
