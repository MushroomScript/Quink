<script setup lang="ts">
import { ref, computed, inject, onMounted, nextTick, watch, watchEffect, type ComputedRef } from 'vue';
import { useEscToClose } from '@/composables/useEscToClose';
import { useRouter, useRoute } from 'vue-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { useNotesStore } from '@/stores/notes';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import type { Note, PersonalReminderRow, GroupReminderRow } from '@/api';
import { api } from '@/api';
import { resolveFileUrl, resolveFileThumbUrl, thumbErrorFallback } from '@/utils/fileUrl';
import { PhUsersThree } from '@phosphor-icons/vue';
import {
  PhCheck,
  PhCheckCircle,
  PhCircle,
  PhCheckSquare,
  PhDotsThreeVertical,
  PhPushPin,
  PhMapPin,
  PhPencilSimple,
  PhArrowCounterClockwise,
  PhTrash,
  PhBell,
  PhBellRinging,
  PhBellSlash,
  PhChatCircleDots,
  PhCopySimple,
} from '@phosphor-icons/vue';
import { REF_LINK_REGEX, renderRefLink, injectRefLinkIcons } from '@/utils/refLink';
import { resolveMarkdownFileUrls } from '@/utils/fileUrl';
import { sanitizeHtml } from '@/utils/htmlSanitize';
import { previewMarkdown } from '@/utils/notePreview';
import { highlightTextByPinyin } from '@/utils/pinyin';
import { startCardDrag, dragState } from '@/utils/cardDnd';
import { unzoomRect, unzoomViewport } from '@/utils/zoom';
import ReminderPicker from '@/components/ReminderPicker.vue';
import { useNow } from '@/composables/useNow';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const props = defineProps<{ note: Note }>();
const store = useNotesStore();
const auth = useAuthStore();

// 群组共享: 判断作者身份 + 共享状态. NoteCard 右上角根据这些显示作者头像 / 已分享标识
const isMyNote = computed(() => !props.note.userId || props.note.userId === auth.user?.id);
const isShared = computed(() => props.note.visibility === 'shared');
const sharedCount = computed(() => props.note.sharedGroupIds?.length ?? 0);
const editorCount = computed(() => props.note.editorCount ?? 0);

// shared 笔记底部 reaction summary + 评论计数 (readonly 展示, 点 NoteCard 走详情交互).
// 只显示 count>0 的 emoji 避免 5 个胶囊占满, 0 评论时整行不显示
const visibleReactions = computed(() => (props.note.reactionSummary || []).filter(r => r.count > 0));
const commentCount = computed(() => props.note.commentCount || 0);
// editorCount > 0 也触发底部 meta 行显示 ("N 人编辑过")
const showSocialMeta = computed(() => isShared.value && (visibleReactions.value.length > 0 || commentCount.value > 0 || editorCount.value > 0));

// 每人完成待办 (todoGroupMode='everyone'): per-user 完成, 所有群成员可点自己的勾 + 看进度 X/N
const isEveryoneTodo = computed(() => props.note.type === 'todo' && props.note.todoGroupMode === 'everyone');
const rosterOverdue = computed(() => !!props.note.rosterDueAt && dayjs().isAfter(dayjs(props.note.rosterDueAt)));
const togglingDone = ref(false);

// 编辑权限胶囊只在群组上下文显示 (/groups/:id 路径), 避免污染灵感/笔记/待办主 view
const route = useRoute();
const inGroupContext = computed(() => route.path.startsWith('/groups/'));
// 群组上下文下用 groupId + 群角色 (GroupDetail provide) 走群级置顶 API, 不走 store.togglePin
const groupIdFromRoute = computed(() => inGroupContext.value ? (route.params.id as string) : null);
const groupRole = inject<ComputedRef<'owner' | 'admin' | 'member' | null>>('groupRole', computed(() => null));
const canPinInGroup = computed(() => inGroupContext.value && (groupRole.value === 'owner' || groupRole.value === 'admin'));
// 删除按钮可见性. 作者本人永远可删; 别人的笔记仅"群组页 + 我是该群 owner/admin"才显示 ("管理操作" 后端校验同款).
// 主视图看到别人共享笔记 (sharedDisplay='all'/'others_shared') 默认不显示删除, 让用户去群组页操作
const canDelete = computed(() => isMyNote.value || canPinInGroup.value);
// 字段权限:
//   主页置顶 = isMyNote && !inGroupContext (仅作者主视图)
//   标完成 / 设群提醒 = isMyNote || canPinInGroup (作者本人 OR 群组上下文管理员)
//   多选 = 群组页要群管理员; 主视图作者本人或私人 (排除"别人共享给我看的")
const canPinInMain = computed(() => isMyNote.value && !inGroupContext.value);
const canChangeTodoStatus = computed(() => isMyNote.value || canPinInGroup.value);
const canMultiSelect = computed(() =>
  inGroupContext.value ? canPinInGroup.value : (isMyNote.value || !isShared.value)
);
// 作者删 fork 版特殊弹窗: 作者主视图列表里看到自己的 fork (parentNoteId 非空) 删除时
// 显示"由 @B @C 编辑过 N 处修改"提示. 群组上下文删 fork 走通用文案 (canDelete 含群管理员).
const isAuthorDeletingFork = computed(() => isMyNote.value && !!(props.note as any).parentNoteId);
const forkEditors = ref<Array<{ userId: string; nickname: string | null }>>([]);
const forkEditCount = ref(0);

// 编辑预判: shared 笔记 + 非作者时看后端返的 canWrite. 没权限 → 直接弹申请编辑权对话框, 不进 NoteEditModal
// (NoteEditModal acquireLock 失败兜底仍保留, 防权限中途被撤的罕见 race)
const canEdit = computed(() => isMyNote.value || !isShared.value || !!(props.note as any).canWrite);
const showRequestPerm = ref(false);
const requestPermMessage = ref('');
const submittingRequest = ref(false);
const requestPermInputEl = ref<HTMLTextAreaElement | null>(null);
// 弹窗 v-if true 自动 focus textarea + dispatch input event 让 customCaret 重算 caret 位置.
// 网页浏览器在 modal-fade Transition (opacity:0→1) opacity:0 时 focus()
// 不真 focus, document.activeElement 不变 → customCaret 的 focusin listener 不触发 → 无 attach → caret 永远不显.
// Electron Chromium 对 opacity:0 元素 focus 比标准浏览器宽松, 所以 PC 端没问题.
// 修法: 等 modal-fade Transition (180ms) 完成后再 focus, 同时多次 dispatch input 兜底 caret 位置计算
watch(showRequestPerm, async (v) => {
  if (!v) return;
  await nextTick();
  // 等 modal-fade Transition 180ms 完成 (opacity 到 1 + scale 到 1) 再 focus, 防 opacity:0 时 web 浏览器拒绝 focus
  setTimeout(() => {
    const el = requestPermInputEl.value;
    if (!el) return;
    el.focus();
    // 多次 dispatch input 兜底 customCaret 在 web 端 Transition 期间算位置可能反复出错
    [0, 150, 350].forEach(delay => {
      setTimeout(() => {
        if (el && document.activeElement === el) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, delay);
    });
  }, 200);
});
async function submitEditRequest() {
  if (submittingRequest.value) return;
  submittingRequest.value = true;
  try {
    await api.requestNoteEditPermission(props.note.id, requestPermMessage.value.trim() || undefined);
    toast.show('已提交申请, 等待作者或管理员审批', 'success', 3000);
    showRequestPerm.value = false;
    requestPermMessage.value = '';
  } catch (e: any) {
    toast.show('申请失败: ' + (e.message || '未知错误'), 'error', 3000);
  } finally { submittingRequest.value = false; }
}

// 三点菜单"编辑"按钮 click: 有写权限直接进 modal, 没权限弹申请对话框 (不进 modal)
function handleEditClick() {
  showMenu.value = false;
  if (canEdit.value) {
    openEditModal?.(props.note);
  } else {
    requestPermMessage.value = '';
    showRequestPerm.value = true;
    // autofocus 由上面 watch(showRequestPerm) 处理
  }
}
// 视觉用的"是否置顶": 群组上下文看 groupPinned (独立于作者全局 pinned), 否则看 note.pinned
const displayPinned = computed(() => inGroupContext.value ? !!props.note.groupPinned : props.note.pinned);

// 置顶 handler: 群组上下文走群级 API + 派事件让 GroupDetail 重拉; 否则走 store.togglePin (主 view 内 vs.notes)
async function handleTogglePin() {
  if (inGroupContext.value && groupIdFromRoute.value) {
    const willPin = !props.note.groupPinned;
    (props.note as any).groupPinned = willPin; // 乐观更新 (props.note 是 reactive, ring 边框立即反映)
    try {
      if (willPin) await api.pinGroupNote(groupIdFromRoute.value, props.note.id);
      else await api.unpinGroupNote(groupIdFromRoute.value, props.note.id);
      toast.show(willPin ? '已置顶' : '已取消置顶', 'success');
      // 派事件让 GroupDetail 重拉群笔记 (server 按 pinned_at DESC 重排, 卡片到顶)
      window.dispatchEvent(new CustomEvent('quink-group-notes-changed', { detail: { groupId: groupIdFromRoute.value } }));
    } catch (e: any) {
      (props.note as any).groupPinned = !willPin;
      toast.show(e?.message || '操作失败', 'error');
    }
  } else {
    store.togglePin(props.note.id);
  }
}

const router = useRouter();
const toast = useToast();
const openEditModal = inject<(note: Note) => void>('openEditModal');

// 拖动检测: mousedown 时记录起点和时间, click 触发时跟 e.clientX/Y 比较
// 距离 > 5px 或 按住 > 500ms → 拖动(选字 / 长按), 跳过进详情
const DRAG_DISTANCE_THRESHOLD = 5;
const DRAG_TIME_THRESHOLD = 500;
let mouseDownX = 0;
let mouseDownY = 0;
let mouseDownAt = 0;
function onMouseDown(e: MouseEvent) {
  mouseDownX = e.clientX;
  mouseDownY = e.clientY;
  mouseDownAt = Date.now();
}

// 右键时主动 setSelection 锁定到当前卡片正文 .note-content.
// Electron setZoomFactor != 1 时浏览器原生右键菜单 hit-test 跨 main/renderer 进程坐标转换有偏差,
// "全选"会选到错位卡片. 修法: contextmenu 触发时在 renderer 内 (坐标系正确)选中本卡片正文,
// 浏览器菜单的"全选/复制"看到已有 selection 就作用在它上面, 不再用错位的 hit-test 算 anchor.
// 不 e.preventDefault() — 让浏览器原生菜单照常弹, 只是 selection 已被我们抢先锁定
function onContextMenu(e: MouseEvent) {
  // 用户已经手动选了文字 (非 collapsed) → 不动他的 selection, 让原生菜单按他选的范围工作
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  // 找当前卡片的正文 .note-content (不包含 type/category/time chip + tags)
  const card = (e.currentTarget as HTMLElement);
  const content = card.querySelector('.note-content');
  if (!content) return;
  const range = document.createRange();
  range.selectNodeContents(content);
  sel?.removeAllRanges();
  sel?.addRange(range);
  // selection 选中本卡片正文 → 浏览器原生菜单的"复制"复制本卡片, "全选"会扩展但已有 selection
  // 提示用户菜单作用范围明确, 不再被 zoom hit-test 错位影响选到隔壁卡片
}

function handleClick(e: MouseEvent) {
  if ((e.target as HTMLElement).closest?.('.voice-bubble')) return;
  // 拖动/长按检测放最前: 这种 click 直接 return, 不走任何分支(包括 Ctrl+点击)
  const dx = Math.abs(e.clientX - mouseDownX);
  const dy = Math.abs(e.clientY - mouseDownY);
  const dt = Date.now() - mouseDownAt;
  if (dx > DRAG_DISTANCE_THRESHOLD || dy > DRAG_DISTANCE_THRESHOLD || dt > DRAG_TIME_THRESHOLD) return;
  if (e.ctrlKey || e.metaKey) {
    // Ctrl+点击引用标签 → 跳转详情
    const ref = (e.target as HTMLElement).closest('.note-ref-link');
    if (ref) {
      e.preventDefault();
      e.stopPropagation();
      try {
        const href = ref.getAttribute('data-ref') || '';
        const refId = new URL(href, location.origin).searchParams.get('ref');
        if (refId) { router.push(`/note/${refId}`); return; }
      } catch {}
    }
    // Ctrl+点击空白区 → 选择模式
    if (!store.selectMode) store.toggleSelectMode();
    store.toggleSelect(props.note.id);
    return;
  }
  if (store.selectMode) {
    store.toggleSelect(props.note.id);
    return;
  }
  // 任务列表 checkbox 点击 → 切换 task 状态,不进详情(放 selectMode 之后:选择模式下 checkbox 不响应,整卡片当选择目标)
  const tgt = e.target as HTMLElement;
  if (tgt.tagName === 'INPUT' && (tgt as HTMLInputElement).type === 'checkbox') {
    onTaskCheckboxClick(e, tgt as HTMLInputElement);
    return;
  }
  // 点击卡片内的 a 标签 → 走链接自身处理(引用预览 / 附件打开 / 外部网址),不进详情
  if ((e.target as HTMLElement).closest?.('a')) return;
  router.push(`/note/${props.note.id}`);
}

// 任务列表 checkbox 点击 → toggle markdown 源里对应的 - [x] / - [ ] + 后台保存
// 跟 NoteDetail 同模式: regex 匹配第 N 个 task 标记,兼容 `-` / `*` 列表标记和 `[x] / [X] / [ ]` 三种状态;
// 立即视觉同步(input.checked + props.note.content 触发 watchEffect 重渲染),失败回滚
async function onTaskCheckboxClick(e: MouseEvent, input: HTMLInputElement) {
  e.preventDefault();
  e.stopPropagation();
  const wrapper = e.currentTarget as HTMLElement;
  const allCheckboxes = Array.from(wrapper.querySelectorAll('input[type="checkbox"]'));
  const taskIndex = allCheckboxes.indexOf(input);
  if (taskIndex < 0) return;

  const oldContent = props.note.content;
  let idx = 0;
  // 闭包捕获 toggle 方向: mark==' ' → 切到 done; mark=='x'/'X' → 切到 undone.
  // 用 toast 反馈,让用户在列表里隔着卡片也能看到操作生效
  let toggledToDone = false;
  const newContent = oldContent.replace(/^(\s*[-*]\s+\[)([xX ])(\])/gm, (match, prefix, mark, suffix) => {
    if (idx === taskIndex) {
      toggledToDone = mark === ' ';
      idx++;
      return `${prefix}${mark === ' ' ? 'x' : ' '}${suffix}`;
    }
    idx++; return match;
  });
  if (newContent === oldContent) return;

  input.checked = !input.checked;
  props.note.content = newContent;
  try {
    await store.updateNote(props.note.id, { content: newContent, skipTimestamp: true });
    toast.show(toggledToDone ? '已完成' : '已取消完成', toggledToDone ? 'success' : 'default');
  } catch (err) {
    props.note.content = oldContent;
    input.checked = !input.checked;
    console.error('[NoteCard] toggle task failed:', err);
  }
}

// 每人完成待办: toggle 我的完成 (per-user). 直接 mutate props.note.todoDoneSummary 让卡片即时反映
// (个人列表 = store 笔记 / 群组 = GroupDetail 本地 ref, mutate props 两种都生效), 失败回滚. 照搬 reaction 乐观更新.
async function onToggleTodoDone() {
  if (togglingDone.value) return;
  const s = props.note.todoDoneSummary;
  if (!s) return;
  togglingDone.value = true;
  const prev = { ...s, roster: s.roster ? [...s.roster] : undefined };
  const newMine = !s.mine;
  props.note.todoDoneSummary = {
    ...s,
    mine: newMine,
    completed: Math.max(0, s.completed + (newMine ? 1 : -1)),
    roster: s.roster?.map(m => m.userId === auth.user?.id ? { ...m, done: newMine } : m),
  };
  try {
    const res = await api.toggleTodoDone(props.note.id);
    // 后端权威 summary (不含 roster, 保留本地翻转过的 roster)
    props.note.todoDoneSummary = { ...res.data.summary, roster: props.note.todoDoneSummary?.roster, hideProgress: props.note.todoDoneSummary?.hideProgress };
    // 跨 view 同步: 群组界面点完成 → 个人列表 Todos 同一条也更新 (props.note 可能是 GroupDetail 本地 ref, syncTodoDone 补同步 store viewState)
    store.syncTodoDone(props.note.id, res.data.summary);
  } catch (err) {
    props.note.todoDoneSummary = prev; // 回滚
    toast.show('操作失败', 'error');
    console.error('[NoteCard] toggleTodoDone failed:', err);
  } finally {
    togglingDone.value = false;
  }
}
const showMenu = ref(false);

// 三点菜单"选择": 进入 selectMode 同时把当前卡片入选
function enterSelectMode() {
  if (!store.selectMode) store.toggleSelectMode();
  if (!store.selectedIds.has(props.note.id)) store.toggleSelect(props.note.id);
  showMenu.value = false;
}

// 自定义拖动 (cardDnd.ts pointer events 实现, 不用 HTML5 DnD); 当前卡片是否在被拖
const isDragging = computed(() => dragState.active && dragState.ids.includes(props.note.id));

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  // 胶囊音频链接自己处理 seek 拖动 (audio.ts pointer 监听), 不要让卡片抢
  const audioA = (e.target as HTMLElement)?.closest?.('a') as HTMLAnchorElement | null;
  if (audioA) {
    const href = audioA.getAttribute('href') || '';
    if (/\.(webm|mp3|wav|ogg|m4a)(\?.*)?$/i.test(href)) return;
  }
  // 多选模式下: 拖的永远是被选中的卡片, 不管鼠标按哪张 (按未选卡片不响应, 按已选卡片也是拖整批).
  //   - 没选任何卡片 → return 不响应拖动 (约定: 多选模式按未选区不应抓起任何东西)
  //   - 选 1 张 → 拖那 1 张 (即使鼠标按的是另一张)
  //   - 选 N 张 → 拖那 N 张
  // 普通模式: 拖当前卡片 (单选)
  let ids: string[];
  if (store.selectMode) {
    if (store.selectedIds.size === 0) return;
    ids = Array.from(store.selectedIds);
  } else {
    ids = [props.note.id];
  }
  const isBatch = ids.length > 1;
  // ghost 文字 (兜底, ghostHtml 没值时显示): 多条显数量, 单条显内容前 120 字
  const firstId = ids[0];
  const firstNote = ids.length === 1 && firstId === props.note.id ? props.note : null;
  const text = isBatch
    ? `${ids.length} 条内容`
    : (firstNote?.content?.replace(/[#*`>~\-!\[\]]/g, '').trim().slice(0, 120) || typeLabels[firstNote?.type || props.note.type] || '内容');
  // 单选 (无论是否在多选模式) 且 ids[0] 就是本卡片 → 复用 renderedContent (零开销).
  // 多选 / 拖别的卡片 → 传 ids 让 cardDnd 在拖动启动时从 DOM 拿选中卡片的 .vditor-reset innerHTML 串联.
  startCardDrag(e, {
    ids,
    type: ids.length === 1 && firstNote ? firstNote.type : null,
    category: ids.length === 1 && firstNote ? (firstNote.category || '') : '',
    text,
    html: ids.length === 1 && firstNote ? renderedContent.value : undefined,
  });
}
const confirmDelete = ref(false);
useEscToClose(confirmDelete);
const menuBtn = ref<HTMLElement>();
const menuPos = ref<{ top: string; right: string }>({ top: '0px', right: '0px' });

// Teleport+fixed 可跨 main 的 overflow，但不能跨 viewport 物理边界（窗口外不能渲染）；
// 下方空间不够菜单（估 ~160px）就向按钮上方弹.
// unzoomRect + unzoomViewport: 网页版缩放后菜单错位 — CSS zoom 下 rect 是 zoomed,
// inline px 渲染又被 zoom 一次, 必须归一到 unzoomed. 详见 utils/zoom.ts.
function toggleMenu() {
  if (showMenu.value) { showMenu.value = false; return; }
  if (menuBtn.value) {
    const r = unzoomRect(menuBtn.value);
    const { vw, vh } = unzoomViewport();
    const estMenuH = 160;
    const flipUp = r.bottom + 4 + estMenuH > vh;
    menuPos.value = {
      top: flipUp ? `${r.top - estMenuH - 4}px` : `${r.bottom + 4}px`,
      right: `${vw - r.right}px`,
    };
  }
  showMenu.value = true;
}

async function askDelete() {
  showMenu.value = false;
  // 作者删 fork 版: 拉编辑历史 distinct editor 名字, 弹特殊确认
  if (isAuthorDeletingFork.value) {
    try {
      const res = await api.getNoteEditHistory(props.note.id);
      const seen = new Map<string, { userId: string; nickname: string | null }>();
      for (const r of res.data) {
        if (!seen.has(r.userId)) seen.set(r.userId, { userId: r.userId, nickname: (r as any).nickname || null });
      }
      forkEditors.value = Array.from(seen.values());
      forkEditCount.value = res.data.length;
    } catch (e) {
      // 拉失败兜底: 走通用弹窗
      forkEditors.value = [];
      forkEditCount.value = 0;
    }
  }
  confirmDelete.value = true;
}

// "另存为": 复制成自己的私人副本. 文案按 type 决定. 保存成功后本地同步插入 (SSE 给其他设备由后端 publish 触发)
async function doDuplicate() {
  showMenu.value = false;
  try {
    const res = await api.duplicateNote(props.note.id);
    const label = props.note.type === 'todo' ? '待办' : (props.note.type === 'note' ? '笔记' : '灵感');
    toast.show(`已另存为我的${label}`, 'success', 3000);
    // 本设备同步副本到对应 view (拉单条插入"首位 after pinned"). 同账号其他设备由后端 publish 'note-created' SSE 触发同款路径
    store.syncNoteCreated(res.data.id);
  } catch (e: any) {
    toast.show(e?.message || '另存失败', 'error', 3000);
  }
}

async function doDelete() {
  confirmDelete.value = false;
  // 留个 snapshot 给撤销用: store.deleteNote 走 splice 会让 props.note 引用失效, 必须先拷贝
  const snapshot = { ...props.note };
  // try-catch 兜底 — 后端 403 / 网络错时之前会静默(toast.show 不执行 = "什么都不提示")
  // 群组上下文 admin 删别人笔记时透传 groupId, 让后端写 deletedInGroupId 进群回收站
  const groupId = !isMyNote.value && inGroupContext.value ? groupIdFromRoute.value : null;
  try {
    await store.deleteNote(props.note.id, groupId ? { groupId } : undefined);
    // admin 删别人笔记进群回收站 → 派事件让 GroupDetail 刷新 trashCount 胶囊
    if (groupId) {
      window.dispatchEvent(new CustomEvent('quink-group-trash-changed', { detail: { groupId } }));
    }
  } catch (e: any) {
    toast.show(e?.message || '删除失败', 'error', 3000);
    return;
  }
  toast.show('已移到回收站', {
    duration: 5000,
    action: {
      label: '撤销',
      onClick: async () => {
        const n = await store.undoDelete([snapshot]);
        if (!n) toast.show('撤销失败', 'error');
      },
    },
  });
}

const renderedContent = ref('');

// Markdown → HTML rendering with search highlight
import Vditor from 'vditor';

watchEffect(async (onCleanup) => {
  // 防 race condition: content 变化触发 callback 时,上一次的 await Vditor.md2html(旧内容)
  // 可能还 pending。如果旧的 await 后完成 → 用旧 html 覆盖 renderedContent → UI"不刷新"
  // (曾出现偶发的"编辑后列表不更新")。onCleanup 标记过期,过期结果不回写
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  // 卡片是预览: 剥 base64 + 截断. 跟 Trash 渲染、useMasonry estimateHeight 共用 previewMarkdown,
  // 三处必须一致, 否则估算按原始 content 数图高估 → 瀑布流列高失衡 (那列空着). 见 utils/notePreview
  const content = previewMarkdown(props.note.content);
  try {
    // 任务列表:* [X] → - [x] (Vditor md2html 只认 - 开头的任务列表)
    // 历史污染清理:旧版 RichEditor 的播放按钮 ▶/⏸ 被 Vditor 序列化进了 markdown,这里剥掉
    let md = content.replace(/[▶⏸]/g, '').replace(/^\* \[([ xX])\]/gm, (_, c) => `- [${c.toLowerCase()}]`);
    // 引用链接:先在 Markdown 层面简化(旧数据可能有多行 label,Vditor 解析不了)
    const processed = md.replace(REF_LINK_REGEX, (_, label, href) => renderRefLink(label, href, 20));
    // 文件链接裸名拼前缀: 笔记里 `[xxx](文件名.ext)` → `[xxx](/api/uploads/文件名.ext)`,让 <a>/<img>/<audio> 能加载
    const withFiles = resolveMarkdownFileUrls(processed);
    let html = await Vditor.md2html(withFiles, { cdn: '/vditor' } as any);
    html = injectRefLinkIcons(html);
    // 列表卡片 task list checkbox 可点击: lute 默认输出 disabled,浏览器对 disabled input 不触发 click 事件。
    // 跟 NoteDetail 同处理 —— DOM 剥 disabled(regex 易漏: 属性顺序 / 空值 / 自闭合斜杠 等变体)
    {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('input[type="checkbox"]').forEach((i) => i.removeAttribute('disabled'));
      html = tmp.innerHTML;
    }
    // 搜索关键词高亮（只在标签之间的文本上替换，避免破坏 a[href]、class 等 HTML 属性 → 进而破坏音频胶囊等 CSS 选择器）
    // highlightTextByPinyin 同时支持字面 + 拼音(全拼/首字母/混合),让 query="zb" 也能在 content="周报..." 里命中"周报"高亮
    const q = store.searchQuery;
    if (q && q.trim()) {
      html = html.replace(/(<[^>]+>)|([^<]+)/g, (_, tag, text) =>
        tag ? tag : highlightTextByPinyin(text, q)
      );
    }
    html = sanitizeHtml(html);
    if (cancelled) return;
    renderedContent.value = html;
  } catch {
    if (cancelled) return;
    renderedContent.value = content;
  }
});

const timeAgo = computed(() => dayjs(props.note.createdAt).fromNow());
const fullTime = computed(() => dayjs(props.note.createdAt).format('YYYY-MM-DD HH:mm'));

// 提醒分家: 我的个人提醒 + 我所在群的群提醒 (onMounted 拉, saveReminder 后本地 mutate)
// 优先级 (用于铃铛 + 设置按钮显示): 我的个人提醒 > 我所在群的最早一条群提醒
// 老 todoDue 字段 fallback 已删 (notes.todo_due 列移除)
const myPersonalReminder = ref<PersonalReminderRow | null>(null);
const myGroupReminders = ref<GroupReminderRow[]>([]);
const groupReminderMuted = ref(false); // 卡片级 mute 状态
const remindersLoaded = ref(false);
async function loadReminders() {
  try {
    const res = await api.getNoteReminders(props.note.id);
    myPersonalReminder.value = res.data.personal;
    myGroupReminders.value = res.data.group;
    groupReminderMuted.value = !!res.data.muted;
  } catch (e) {
    console.error('[NoteCard] loadReminders failed:', e);
  } finally {
    remindersLoaded.value = true;
  }
}
// 切换屏蔽群提醒. 仅影响调用者本人 (scheduler 到点 + POST 设置通知都过滤 mutedSet)
async function toggleGroupReminderMute() {
  showMenu.value = false;
  const next = !groupReminderMuted.value;
  groupReminderMuted.value = next; // 乐观更新
  try {
    if (next) await api.muteNoteGroupReminder(props.note.id);
    else await api.unmuteNoteGroupReminder(props.note.id);
    toast.show(next ? '已屏蔽此待办的群提醒' : '已恢复接收', 'success');
  } catch (e: any) {
    groupReminderMuted.value = !next; // 回滚
    toast.show(e?.message || '操作失败', 'error');
  }
}
onMounted(() => {
  // 只 todo 类型才需要拉 (其他类型铃铛不显示)
  if (props.note.type === 'todo') loadReminders();
});

// effectiveReminder: 给铃铛 / 提醒文案 / "设置/编辑" 按钮文案用.
// 按 dueAt 升序优先 (最先触发的最紧迫, 比 personal/group 优先级更直观).
// NoteDetail 双 chip 同时展示, NoteCard 只展示这条最紧迫的 (卡片寸土寸金), 多个走详情看.
const effectiveReminder = computed<{ dueAt: string | null; rrule: string | null; source: 'personal' | 'group' | null }>(() => {
  const candidates: Array<{ dueAt: string; rrule: string | null; source: 'personal' | 'group' }> = [];
  if (myPersonalReminder.value) {
    candidates.push({ dueAt: myPersonalReminder.value.dueAt, rrule: myPersonalReminder.value.rrule, source: 'personal' });
  }
  if (myGroupReminders.value.length > 0) {
    const g = myGroupReminders.value[0];
    candidates.push({ dueAt: g.dueAt, rrule: g.rrule, source: 'group' });
  }
  if (candidates.length === 0) return { dueAt: null, rrule: null, source: null };
  candidates.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return candidates[0];
});

// 提醒时间显示: 简短相对时间 (今天 14:30 / 明天 9:00 / 6月10日 / 已过) + 鼠标 hover 看完整
// 用响应式 nowRef 让 computed 依赖时间流逝重算 — 否则单次提醒 scheduler 不动 due, 时间过去后卡片永远显示"今天 09:30"不会变"已过"
const nowRef = useNow();
const reminderText = computed(() => {
  const due = effectiveReminder.value.dueAt;
  if (!due) return '';
  const d = dayjs(due);
  const now = dayjs(nowRef.value);
  if (d.isBefore(now)) return '已过';
  if (d.isSame(now, 'day')) return `今天 ${d.format('HH:mm')}`;
  if (d.isSame(now.add(1, 'day'), 'day')) return `明天 ${d.format('HH:mm')}`;
  if (d.diff(now, 'day') < 7) return d.format('ddd HH:mm');
  return d.format('M月D日 HH:mm');
});
const reminderFullText = computed(() => {
  const due = effectiveReminder.value.dueAt;
  if (!due) return '';
  const t = dayjs(due).format('YYYY-MM-DD HH:mm');
  const sourceLabel = effectiveReminder.value.source === 'group' ? '（群提醒）' : '';
  return effectiveReminder.value.rrule ? `${t}${sourceLabel}（重复: ${effectiveReminder.value.rrule}）` : `${t}${sourceLabel}`;
});

// 是否能设群提醒. 仅 inGroupContext + 我是该群 owner/admin + 笔记 share 到当前群
const canSetGroupReminder = computed(() => {
  if (!inGroupContext.value || !groupIdFromRoute.value) return false;
  if (groupRole.value !== 'owner' && groupRole.value !== 'admin') return false;
  return isShared.value && (props.note.sharedGroupIds || []).includes(groupIdFromRoute.value);
});
// 当前群是否已有群提醒 (用于按钮文案 "设置/编辑/取消")
const currentGroupReminder = computed(() => {
  const gid = groupIdFromRoute.value;
  if (!gid) return null;
  return myGroupReminders.value.find(r => r.groupId === gid) || null;
});

// 提醒弹窗状态机: mode 区分个人/群提醒 (复用同一 ReminderPicker)
const reminderPickerOpen = ref(false);
const reminderPickerMode = ref<'personal' | 'group'>('personal');
function openReminderPicker() {
  showMenu.value = false;
  reminderPickerMode.value = 'personal';
  reminderPickerOpen.value = true;
}
function openGroupReminderPicker() {
  showMenu.value = false;
  reminderPickerMode.value = 'group';
  reminderPickerOpen.value = true;
}
const reminderPickerInitial = computed(() => {
  if (reminderPickerMode.value === 'group') {
    return { remindAt: currentGroupReminder.value?.dueAt ?? null, rrule: currentGroupReminder.value?.rrule ?? null };
  }
  return { remindAt: myPersonalReminder.value?.dueAt ?? null, rrule: myPersonalReminder.value?.rrule ?? null };
});

async function saveReminder(payload: { remindAt: string | null; rrule: string | null }) {
  const mode = reminderPickerMode.value;
  try {
    if (mode === 'group') {
      const gid = groupIdFromRoute.value!;
      if (payload.remindAt) {
        const res = await api.setGroupReminder(props.note.id, { groupId: gid, dueAt: payload.remindAt, rrule: payload.rrule });
        // 本地 mutate: 移除当前群旧条目 + 加入新条目, 让铃铛立即反映
        const others = myGroupReminders.value.filter(r => r.groupId !== gid);
        myGroupReminders.value = [{
          id: '', noteId: props.note.id, groupId: gid,
          dueAt: res.data.dueAt, rrule: res.data.rrule, remindSentAt: null,
          createdBy: auth.user?.id || '', createdAt: new Date().toISOString(),
        }, ...others];
        toast.show('已设置群提醒', 'success');
      } else {
        await api.deleteGroupReminder(props.note.id, gid);
        myGroupReminders.value = myGroupReminders.value.filter(r => r.groupId !== gid);
        toast.show('已取消群提醒', 'success');
      }
    } else {
      if (payload.remindAt) {
        const res = await api.setPersonalReminder(props.note.id, { dueAt: payload.remindAt, rrule: payload.rrule });
        myPersonalReminder.value = {
          id: myPersonalReminder.value?.id || '', userId: auth.user?.id || '', noteId: props.note.id,
          dueAt: res.data.dueAt, rrule: res.data.rrule, remindSentAt: null,
          createdAt: myPersonalReminder.value?.createdAt || new Date().toISOString(),
        };
        toast.show('已设置提醒', 'success');
      } else {
        await api.deletePersonalReminder(props.note.id);
        myPersonalReminder.value = null;
        toast.show('已清除提醒', 'success');
      }
    }
  } catch (e: any) {
    console.error('[NoteCard] saveReminder failed:', e);
    toast.show(e?.message || '保存失败', 'error');
  }
}

// 命名约定: quink=灵感, note=笔记, todo=待办. link 类型已废弃删
const typeLabels: Record<string, string> = { quink: '灵感', note: '笔记', todo: '待办' };
// quink 固定 blueberry 不跟主题 (.type-chip-quink 定义在 style.css). 跟 note/todo 一样固定色
const typeColor: Record<string, string> = {
  quink: 'type-chip-quink',
  note: 'bg-emerald-100 text-emerald-600',
  todo: 'bg-amber-100 text-amber-600',
};
</script>

<template>
  <!-- 非 selectMode: 仅 type chip 是拖动 handle (其他地方鼠标按住选文字); selectMode: 整卡片可拖 (多选批量移动).
       自定义拖动 (cardDnd.ts), 非 HTML5 DnD: selectMode 时整卡片 @pointerdown; 非 selectMode 时 type chip @pointerdown -->
  <div class="bg-white rounded-2xl shadow-sm hover:shadow-md transition-all duration-200 group relative card-draggable"
    :data-note-id="note.id"
    :class="{ 'ring-2 ring-primary/50': displayPinned, 'ring-2 ring-primary': store.selectedIds.has(note.id), 'opacity-50': isDragging }"
    @pointerdown="store.selectMode ? onPointerDown($event) : undefined"
    @contextmenu="onContextMenu">
    <div class="px-3 py-2.5 md:px-4 md:py-3 cursor-pointer" @click="handleClick" @mousedown="onMouseDown">
      <div class="flex items-center gap-2 mb-2">
        <!-- 多选 checkbox: 跟 task list 视觉接近 — 空心圆 border (未选) / 实心主色 + 白勾 (已选);
             用 w-[18px] h-[18px] 显式像素值 (Tailwind 默认无 4.5 spacing, w-4.5 会渲染成 0 尺寸残留点) -->
        <div v-if="store.selectMode"
          class="w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center shrink-0 transition-all"
          :class="store.selectedIds.has(note.id) ? 'bg-primary border-primary' : 'border-gray-400 bg-white hover:border-primary'">
          <svg v-if="store.selectedIds.has(note.id)" class="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none">
            <path d="M5 12l5 5L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <!-- type chip 在非 selectMode 时充当拖动 handle (整卡片不 draggable, 让正文可选文字); selectMode 时不需要它单独拖, 整卡片接管 -->
        <!-- shrink-0 whitespace-nowrap: 防 chip 行内容溢出时 type chip 被压扁让"灵感"两字纵向挤压 (实测 case) -->
        <span class="text-[11px] px-2 py-0.5 rounded-full font-medium select-none touch-none shrink-0 whitespace-nowrap"
          :class="[typeColor[note.type], !store.selectMode ? 'cursor-grab active:cursor-grabbing' : '']"
          @pointerdown.stop="!store.selectMode ? onPointerDown($event) : undefined">
          {{ typeLabels[note.type] }}
        </span>
        <!-- category 紧贴类型 chip 之后 (视觉上"分类"跟"类型"语义同组应该挨着) -->
        <span v-if="note.category" class="text-xs text-gray-400 truncate min-w-0">{{ note.category }}</span>
<!-- 我自己发的共享笔记加 "已分享" chip; 数量在详情页/title hover 看. 字号 padding 跟 type chip 一致.
             别人发的显示作者头像 + nickname -->
        <span v-if="isMyNote && isShared && sharedCount > 0"
          class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium bg-primary-light text-primary-dark select-none whitespace-nowrap"
          :title="`已分享到 ${sharedCount} 个群`">
          <PhUsersThree size="0.75rem" weight="fill" />
          <span>已分享</span>
        </span>
        <!-- 作者头像 + nickname: 头像 shrink-0 保留, nickname min-w-0+truncate 让它跟 category 一起做"可压缩担当".
             不让整 span shrink-0, 否则 nickname 强占空间挤爆 NoteCard 右边把三点推出卡片外 (已知问题: 三点出卡片点不到) -->
        <span v-else-if="!isMyNote && (note as any).authorNickname"
          class="inline-flex items-center gap-1 text-[10px] text-gray-500 select-none min-w-0"
          :title="`@${(note as any).authorNickname}`">
          <img v-if="(note as any).authorAvatar" :src="resolveFileThumbUrl((note as any).authorAvatar)"
            @error="thumbErrorFallback($event, resolveFileUrl((note as any).authorAvatar))"
            class="w-4 h-4 rounded-full object-cover shrink-0" alt="" />
          <div v-else class="w-4 h-4 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[8px] font-bold shrink-0">
            {{ ((note as any).authorNickname || '?').charAt(0).toUpperCase() }}
          </div>
          <span class="truncate min-w-0">{{ (note as any).authorNickname }}</span>
          <span v-if="note.todoDoneSummary?.groupName" class="inline-flex items-center gap-0.5 shrink-0 text-gray-400">
            <PhUsersThree size="0.7rem" weight="fill" />{{ note.todoDoneSummary.groupName }}
          </span>
        </span>
        <!-- 提醒铃铛: 仅 todo 且 effectiveReminder 有 due 时显示. 数据源优先 personal > group > legacy todoDue -->
        <span v-if="note.type === 'todo' && effectiveReminder.dueAt"
          class="ml-auto flex items-center gap-1 text-[11px] cursor-pointer hover:opacity-70 shrink-0 whitespace-nowrap"
          :class="(groupReminderMuted && effectiveReminder.source === 'group') || reminderText === '已过' ? 'text-gray-400' : 'text-amber-600'"
          :title="reminderFullText"
          @click.stop="openReminderPicker">
          <!-- muted=true 且 source=group 时铃铛改 PhBellSlash 提示已屏蔽, 提醒时间仍显示 -->
          <PhBellSlash v-if="groupReminderMuted && effectiveReminder.source === 'group'" size="0.875rem" weight="fill" />
          <PhBellRinging v-else-if="effectiveReminder.rrule" size="0.875rem" weight="fill" />
          <PhBell v-else size="0.875rem" weight="fill" />
          <span class="tabular-nums">{{ reminderText }}</span>
        </span>
        <span class="text-[11px] text-gray-400 shrink-0 whitespace-nowrap"
          :class="{ 'ml-auto': !(note.type === 'todo' && effectiveReminder.dueAt) }"
          :title="fullTime">{{ timeAgo }}</span>
        <!-- 三点菜单: shrink-0 关键 — 无之前 chip 撑爆时 button 被压到 width 0, svg overflow 出 button 外
             视觉上"出卡片"但 click 区域为 0, 已知问题"点了没反应"就是这个 -->
        <button ref="menuBtn" @click.stop="toggleMenu"
          class="p-0.5 rounded-md text-gray-300 hover:text-gray-500 hover:bg-gray-100 transition-colors shrink-0">
          <PhDotsThreeVertical size="1.375rem" weight="bold" />
        </button>
      </div>

      <p v-if="note.summary" class="text-xs text-gray-500 mb-1.5 italic">{{ note.summary }}</p>
      <div class="text-gray-700 note-content">
        <div class="vditor-reset line-clamp-4" v-html="renderedContent" />
      </div>

      <div v-if="note.tags && note.tags.length > 0" class="flex flex-wrap gap-1.5 mt-2">
        <span v-for="tag in note.tags" :key="tag" class="text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
          #{{ tag }}
        </span>
      </div>

      <!-- 每人完成待办: 我的完成勾 + 进度 X/N (per-user, 所有群成员可点自己的) -->
      <div v-if="isEveryoneTodo && note.todoDoneSummary" class="flex items-center gap-2 mt-2 flex-wrap">
        <button @click.stop="onToggleTodoDone" :disabled="togglingDone"
          class="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors"
          :class="note.todoDoneSummary.mine ? 'bg-primary-light text-primary-dark' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'">
          <PhCheckCircle v-if="note.todoDoneSummary.mine" size="1rem" weight="fill" />
          <PhCircle v-else size="1rem" />
          <span>{{ note.todoDoneSummary.mine ? '已完成' : '我要完成' }}</span>
        </button>
        <span v-if="!note.todoDoneSummary.hideProgress" class="text-[11px] text-gray-500 tabular-nums">{{ note.todoDoneSummary.completed }}/{{ note.todoDoneSummary.total }} 完成</span>
        <span v-if="rosterOverdue" class="text-[11px] text-orange-500 font-medium">已截止</span>
      </div>

      <!-- 共享笔记底部 reaction + 评论计数 + 编辑人数 (readonly 展示, 点 NoteCard 走 NoteDetail 交互) -->
      <div v-if="showSocialMeta" class="flex items-center gap-3 mt-2 text-[11px] text-gray-500">
        <span v-for="r in visibleReactions" :key="r.emoji" class="inline-flex items-center gap-0.5">
          <span class="text-[13px] leading-none">{{ r.emoji }}</span>
          <span class="tabular-nums">{{ r.count }}</span>
        </span>
        <span v-if="commentCount > 0" class="inline-flex items-center gap-1">
          <PhChatCircleDots size="0.875rem" weight="fill" />
          <span class="tabular-nums">{{ commentCount }}</span>
        </span>
        <!-- 非作者编辑次数 (作者改不计). NoteDetail 点开看完整列表 -->
        <span v-if="editorCount > 0" class="inline-flex items-center gap-1" :title="`${editorCount} 人编辑过`">
          <PhPencilSimple size="0.875rem" weight="fill" />
          <span class="tabular-nums">{{ editorCount }}</span>
        </span>
      </div>
    </div>

    <!-- 下拉菜单：Teleport 到 body 避免被祖先 overflow 截断（卡片靠底部时菜单消失）；
         遮罩必须一起 Teleport，否则就是 CLAUDE.md 警告的"半个 Teleport"——会被 stacking context 撕裂 -->
    <Teleport to="body">
      <Transition enter-active-class="transition duration-100 ease-out" enter-from-class="opacity-0 scale-95"
        leave-active-class="transition duration-75 ease-in" leave-to-class="opacity-0 scale-95">
        <div v-if="showMenu" class="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-[var(--z-overlay)] min-w-[110px] [&_svg]:mt-px"
          :style="menuPos">
          <!-- 主页置顶 仅作者主视图; 群内置顶 仅群组上下文管理员. canPinInMain / canPinInGroup -->
          <button v-if="canPinInMain || canPinInGroup"
            @click.stop="handleTogglePin(); showMenu = false"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhPushPin v-if="displayPinned" size="0.875rem" weight="fill" />
            <PhMapPin v-else size="0.875rem" weight="fill" />
            <span>{{ displayPinned ? (inGroupContext ? '取消群内置顶' : '取消置顶') : (inGroupContext ? '群内置顶' : '置顶') }}</span>
          </button>
          <!-- 编辑: 永远显示. 前端预判 canWrite, 没权限直接弹申请对话框 (NoteEditModal acquireLock 兜底仍在) -->
          <button @click.stop="handleEditClick()"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhPencilSimple size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>编辑</span>
          </button>
          <!-- 标完成 = 作者本人 OR 群组管理员; 普通成员含 grants 不显示 -->
          <button v-if="note.type === 'todo' && canChangeTodoStatus" @click.stop="store.toggleTodo(note.id); showMenu = false"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhArrowCounterClockwise v-if="note.todoStatus === 'done'" size="0.875rem" weight="fill" style="margin-top: 2px" />
            <PhCheck v-else size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>{{ note.todoStatus === 'done' ? '标记未完成' : '标记已完成' }}</span>
          </button>
          <!-- 设个人提醒, todo 任何人都能设 (个人 = 我自己收, 别人看不到). 数据走 note_personal_reminders 表 -->
          <button v-if="note.type === 'todo'" @click.stop="openReminderPicker"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhBell size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>{{ myPersonalReminder ? '编辑个人提醒' : '设置个人提醒' }}</span>
          </button>
          <!-- 设群提醒, 仅 inGroupContext + 我是该群 owner/admin + 笔记 share 到此群 -->
          <button v-if="note.type === 'todo' && canSetGroupReminder" @click.stop="openGroupReminderPicker"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhBellRinging size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>{{ currentGroupReminder ? '编辑群提醒' : '设置群提醒' }}</span>
          </button>
          <!-- 屏蔽此待办的群提醒 toggle. 仅 todo + 有我可见的群提醒时显示. 跨所有 share 群对该笔记生效 -->
          <button v-if="note.type === 'todo' && myGroupReminders.length > 0" @click.stop="toggleGroupReminderMute"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhBellSlash v-if="!groupReminderMuted" size="0.875rem" weight="fill" style="margin-top: 2px" />
            <PhBell v-else size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>{{ groupReminderMuted ? '恢复此待办群提醒' : '屏蔽此待办群提醒' }}</span>
          </button>
          <!-- 另存为: 仅群组界面显示 (主视图含自己分享的都不显示, 只有群组上下文有"复制成自己副本"语义). 按 type 决定文案 -->
          <button v-if="inGroupContext" @click.stop="doDuplicate()"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhCopySimple size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>另存为我的{{ typeLabels[note.type] || '副本' }}</span>
          </button>
          <!-- 多选: 群组页要群管理员; 主视图作者本人或非共享 (排除主视图见到的别人共享笔记) -->
          <button v-if="canMultiSelect" @click.stop="enterSelectMode()"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
            <PhCheckSquare size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>多选</span>
          </button>
          <div v-if="canDelete" class="border-t border-gray-100 my-0.5"></div>
          <button v-if="canDelete" @click.stop="askDelete()"
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 transition-colors">
            <PhTrash size="0.875rem" weight="fill" style="margin-top: 2px" />
            <span>删除</span>
          </button>
        </div>
      </Transition>
      <div v-if="showMenu" class="fixed inset-0 z-[var(--z-overlay-backdrop)]" @click="showMenu = false" />
    </Teleport>

    <!-- 提醒设置弹窗 (复用同一组件, mode 区分个人/群提醒) -->
    <ReminderPicker
      v-model:open="reminderPickerOpen"
      :remind-at="reminderPickerInitial.remindAt"
      :rrule="reminderPickerInitial.rrule"
      @save="saveReminder"
    />

    <!-- 申请编辑权对话框: 没 write 权限的人点编辑触发, 不走 NoteEditModal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showRequestPerm" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/30" @click="showRequestPerm = false" />
          <div class="relative bg-white rounded-xl shadow-xl p-5 w-96 max-w-[90vw]">
            <p class="text-sm text-gray-700 font-medium mb-1">申请编辑权限</p>
            <p class="text-xs text-gray-400 mb-3">
              {{ (note.editPermission || 'admin') === 'admin' ? '这条笔记仅管理员可编辑' : '这条笔记所有人可编辑' }}, 提交后由作者或群管理员审批
            </p>
            <textarea ref="requestPermInputEl" v-model="requestPermMessage" rows="3" maxlength="500"
              placeholder="附上申请理由 (可选, 最多 500 字)"
              spellcheck="false"
              class="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs leading-relaxed outline-none focus:border-primary resize-none text-gray-600" />
            <div class="flex gap-2 justify-end mt-4">
              <button @click="showRequestPerm = false"
                class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">取消</button>
              <button @click="submitEditRequest" :disabled="submittingRequest"
                class="px-4 py-1.5 text-xs rounded-lg bg-primary-light text-primary-dark hover:bg-primary/20 disabled:opacity-50 transition-colors font-medium">
                {{ submittingRequest ? '提交中...' : '提交申请' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 删除确认弹窗 (删别人笔记时显示作者名 + 警告, 自己笔记保持简洁; 作者删 fork 版特殊提示) -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="confirmDelete" class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/30" @click="confirmDelete = false" />
          <div class="relative bg-white rounded-xl shadow-xl p-5 w-80 text-center">
            <template v-if="isAuthorDeletingFork && forkEditCount > 0">
              <p class="text-sm text-gray-700 mb-1">删除群内版本</p>
              <p class="text-xs text-gray-400 mb-4">
                这个版本由 {{ forkEditors.map(e => '@' + (e.nickname || '群成员')).join(' ') || '群成员' }} 编辑过, 共 {{ forkEditCount }} 处修改
              </p>
            </template>
            <template v-else>
              <p class="text-sm text-gray-700 mb-1">
                {{ isMyNote ? '删除内容' : `确认删除 @${(note as any).authorNickname || '某人'} 的笔记？` }}
              </p>
              <p class="text-xs text-gray-400 mb-4">
                {{ isMyNote ? '可在回收站找回' : '群成员将看不到这条笔记 (作者本人仍可恢复)' }}
              </p>
            </template>
            <div class="flex gap-2 justify-center">
              <button @click="confirmDelete = false"
                class="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">取消</button>
              <button @click="doDelete()"
                class="px-4 py-1.5 text-xs rounded-lg text-white font-medium bg-red-500 hover:bg-red-600">删除</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
