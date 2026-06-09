// 蘑菇 2026-06-09: 前端复制 server 端的通知类型清单 (跟 packages/server/src/utils/notificationTypes.ts 保持同步).
// Quink 没 shared 包, 前后端各维护一份. 加新通知 type 必须两边同时改

export interface NotificationTypeMeta {
  type: string;
  label: string;
  // 联动 toggle 的其他底层 type. 用户勾"我的编辑权限申请结果"时同时勾上 approved + rejected
  siblings?: string[];
}

export interface NotificationCategoryGroup {
  category: 'reminder' | 'content' | 'group';
  label: string;
  types: NotificationTypeMeta[];
}

export const NOTIFICATION_GROUPS: NotificationCategoryGroup[] = [
  {
    category: 'reminder',
    label: '待办类',
    types: [
      { type: 'reminder-due', label: '个人待办提醒' },
      { type: 'group-reminder-due', label: '群待办提醒' },
      { type: 'reminder-expired', label: '待办失效' },
    ],
  },
  {
    category: 'content',
    label: '内容类',
    types: [
      { type: 'comment-added', label: '有人评论了我的笔记' },
      { type: 'edit-request', label: '有人申请编辑我的笔记' },
      { type: 'duplicated', label: '有人复制了我的笔记' },
      { type: 'fork-by-other', label: '有人编辑了我的笔记' },
      { type: 'edit-request-approved', label: '我的编辑权限申请结果', siblings: ['edit-request-rejected'] },
      { type: 'note-deleted-by-admin', label: '我的笔记被删除' },
      { type: 'note-restored-by-admin', label: '我的笔记被恢复' },
    ],
  },
  {
    category: 'group',
    label: '群组类',
    types: [
      { type: 'group-joined', label: '加入群组成功' },
      { type: 'group-join-rejected', label: '加入群组失败' },
      { type: 'group-join-request', label: '有人申请加入群组' },
      { type: 'group-dissolved', label: '所在群组被解散' },
      { type: 'group-removed', label: '被移出群组' },
      { type: 'group-promoted', label: '被提升为管理员' },
      { type: 'group-demoted', label: '被降为成员' },
      { type: 'group-reminder-set', label: '群内新待办提醒' },
    ],
  },
];

// 所有底层 type 平铺 (含 siblings) - 给"全选时存 null"判断 + 后端校验用
export const ALL_NOTIFICATION_TYPES: string[] = NOTIFICATION_GROUPS.flatMap(g =>
  g.types.flatMap(t => [t.type, ...(t.siblings || [])]),
);

// UI 选项总数 (siblings 合并后, 跟用户在编辑面板看到的 checkbox 数一致). 自动算, 加新选项免改 Settings.vue
export const TOTAL_UI_TYPE_COUNT: number = NOTIFICATION_GROUPS.reduce((s, g) => s + g.types.length, 0);

// 给定 channel.types (底层 type 数组), 算 UI 选项中"勾选"的数量 (主 type 在数组内即算 1)
export function countSelectedUiTypes(types: string[] | null | undefined): number {
  if (!types || types.length === 0) return TOTAL_UI_TYPE_COUNT;
  let n = 0;
  for (const g of NOTIFICATION_GROUPS) {
    for (const t of g.types) {
      if (types.includes(t.type)) n++;
    }
  }
  return n;
}

// 给某个 UI 选项 (meta) 算它代表的所有底层 type
export function metaTypes(t: NotificationTypeMeta): string[] {
  return [t.type, ...(t.siblings || [])];
}
