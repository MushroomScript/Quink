# Followups

集中收录【观察里说过但暂未做】的事, 防止 ship 完后忘掉. 每次 ship 前 Claude 必须 read 这个文件 + 看跟当前 PR 重叠的能不能顺手做掉; ship 后若 commit message 末尾含"留待 PR #X" / "留待 11c" 之类的句子, 必须同步 append 一行到下面对应分组.

## 待补 (无明确 PR 归属, 等蘑菇拍板)

- [ ] 群提醒按钮限定 `inGroupContext` —— 主视图看共享笔记的群管理员看不到"设置群提醒"按钮, 必须切群组页设. 若想主视图也支持需补 editContext 推断 (来源: commit `649170a`, PR #11b). 蘑菇 2026-06-09 评估: 不做, 低频 + 加选群弹窗增复杂度
- [ ] 铃铛短文案不区分个人/群 —— NoteCard 改成"按 dueAt 升序" 优先显示最紧迫的一条 (PR #13 followup commit `<本次 commit>`), 但铃铛旁短文案"今天 14:30" 仍不带 source 标. 实际上 NoteCard 卡片寸土寸金加后缀会挤, hover 看完整 source 即可 (来源: commit `649170a`, PR #11b). 蘑菇 2026-06-09 评估: 不做
- [ ] 通知中心 30 天清理周期视情况调 —— 当前硬编码 30 天清已读通知, 看实际用量看要不要砍 14 / 60 (来源: commit `243c363`, PR #10a). 蘑菇 2026-06-09 评估: 不做, 没投诉
## 已完成 (历史归档, 不要清空)

- [x] `note-deleted-by-admin` 通知 —— admin 删别人笔记时给原作者写一条 (PR #12 一并做, 同时加了 `note-restored-by-admin` 给 restore 流) (原来源: commit `fd8eed6`, PR #10c → 在 PR #12 落地)
- [x] `fork-by-other` 通知 —— 笔记被别人 fork 时给原作者写通知 (PR #13 落地, 原来源: commit `fd8eed6`, PR #10c)
- [x] 评估砍掉部分 toast 重叠 —— 7 处砍 + 1 处反悔保留 (note-edit-request quick-action). 详见 PR #13 段 (原来源: commit `fd8eed6`, PR #10c)
- [x] 移除 scheduler 老 `notes.todo_due` 扫描路径 (PR #13 落地, 原来源: commit `cf4993d`, PR #11a)
- [x] 移除 PATCH `/api/notes/:id` 处理 `todo_due` / `todo_remind_rrule` 字段 (PR #13 落地, 原来源: commit `cf4993d`, PR #11a)
- [x] 删除 `notes.todo_due` / `todo_remind_rrule` / `todo_remind_sent_at` 三列 (PR #13 落地 ALTER TABLE DROP COLUMN, 原来源: commit `cf4993d`, PR #11a)
- [x] AI chat `update_note` 适配 fork —— `confirmMultiGroupSync` 参数让 AI 拒绝多群 root 改 + 提问让用户拍板 (PR #13 落地)
- [x] shared→private 转换约束 —— root 有 fork 子节点拒绝转 (PR #13 落地)
- [x] 统计按 origin 维度 —— `parent_note_id IS NULL` 过滤 (PR #13 落地)
- [x] 导出按 sharedDisplay —— 4 选偏好分支 (PR #13 落地)
- [x] PR #11a legacy 路径 `sent_at` race —— legacy 扫描路径在 PR #13 已删, race 自然消失 (原来源: commit `cf4993d`, PR #11a)
- [x] 通知 `comment-added` 点击跳关联笔记加 commentId anchor —— Notifications.onItemClick 加 type=comment-added/comment-replied 分支跳 /note/X?c=cid; CommentThread route.query.c scrollIntoView + 1.8s 黄色高亮渐隐. 后端 payload 之前已含 commentId (PR #13 followup 2026-06-09)
- [x] notifications 操作审计折中 —— read / read-all 砍 logAudit (高频无掩盖嫌疑, 防 spam audit_logs); delete / clear 保留 (才是掩盖证据的核心场景) (PR #13 followup 2026-06-09)
