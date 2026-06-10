// 通知类型全清单 + 3 category 分组. server + 前端 Settings UI 共用.
// channel.types 白名单字段存这里面的 type 字符串. 加新通知 type 必须同步加这文件.

export interface NotificationTypeMeta {
  type: string;
  label: string;
  // 联动 toggle 的其他底层 type. server 主要消费 type, siblings 给前端 UI 用 (web 端 notificationTypes.ts 同款)
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

export const ALL_NOTIFICATION_TYPES: string[] = NOTIFICATION_GROUPS.flatMap(g =>
  g.types.flatMap(t => [t.type, ...(t.siblings || [])]),
);

// channel.types 为 null/undefined/空数组都视作"全收" (兼容老 row + 新建默认全选)
export function isTypeAllowedForChannel(channelTypes: string[] | null | undefined, type: string): boolean {
  if (!channelTypes || channelTypes.length === 0) return true;
  return channelTypes.includes(type);
}
