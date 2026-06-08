# Followups

集中收录【观察里说过但暂未做】的事, 防止 ship 完后忘掉. 每次 ship 前 Claude 必须 read 这个文件 + 看跟当前 PR 重叠的能不能顺手做掉; ship 后若 commit message 末尾含"留待 PR #X" / "留待 11c" 之类的句子, 必须同步 append 一行到下面对应分组.

## 进 PR #13 (收尾)

- [ ] `fork-by-other` 通知 —— 笔记被别人 fork 时给原作者写通知. 跟 PR #13 fork UI 收尾密切关联 (来源: commit `fd8eed6`, PR #10c)
- [ ] 评估砍掉部分 toast 重叠 —— PR #10c 后通知中心 + OS 通知 + toast 三处都弹, 文案重叠的看砍哪个 (来源: commit `fd8eed6`, PR #10c)
- [ ] 移除 scheduler 老 `notes.todo_due` 扫描路径 —— PR #11a 加的 legacy 兼容路径. 前端切完新 API 后 + 数据观察期满后移除 (来源: commit `cf4993d`, PR #11a)
- [ ] 移除 PATCH `/api/notes/:id` 处理 `todo_due` / `todo_remind_rrule` 字段 —— 前端不再发, 后端不再读 (来源: commit `cf4993d`, PR #11a)
- [ ] 删除 `notes.todo_due` / `todo_remind_rrule` / `todo_remind_sent_at` 三列 —— 前提: legacy 扫描路径 + PATCH 处理都已移除 (来源: commit `cf4993d`, PR #11a)
- [ ] AI chat `update_note` 适配 fork —— 主动问用户改哪一版 (roadmap PR #13 原文)
- [ ] shared→private 转换约束 —— 仅未被任何群修改过能转 (roadmap PR #13)
- [ ] 统计按 origin 维度 —— fork 算 1 条, parent_note_id 链追溯 (roadmap PR #13)
- [ ] 导出按 sharedDisplay (roadmap PR #13)

## 待补 (无明确 PR 归属, 等蘑菇拍板)

- [ ] 通知 `comment-added` 点击跳关联笔记没带 commentId / hash anchor, 用户点进去看不到 highlight 哪条评论. 后续加 anchor 跳具体评论 (来源: commit `f02274b`, PR #10c followup)

- [ ] 群提醒按钮限定 `inGroupContext` —— 主视图看共享笔记的群管理员看不到"设置群提醒"按钮, 必须切群组页设. 若想主视图也支持需补 editContext 推断 (来源: commit `649170a`, PR #11b)
- [ ] 铃铛短文案不区分个人/群 —— 用户同时有个人 + 群提醒时铃铛只显示 personal, 短文案 `reminderText` 没区分来源, 只 hover 看完整 `reminderFullText` 才有"（群提醒）"标. 简化方案; 如果要分要重设 UI (来源: commit `649170a`, PR #11b)
- [ ] 通知中心 30 天清理周期视情况调 —— 当前硬编码 30 天清已读通知, 看实际用量看要不要砍 14 / 60 (来源: commit `243c363`, PR #10a)
- [ ] notifications 操作审计是否真需要 —— 当前 read/delete/clear 都加了 `logAudit`, 防"故意清空通知掩盖证据". 实际用量大时可能 spam 审计表, 看要不要砍 (来源: commit `243c363`, PR #10a)
- [ ] PR #11a legacy 路径 `sent_at` race —— dev 期 tsx watch hot reload 引起同一笔记 60s 触发 2 次. 生产稳定运行不复现, 不修. 上面"移除 legacy 扫描路径"做完自然消失 (来源: commit `cf4993d`, PR #11a)

## 已完成 (历史归档, 不要清空)

- [x] `note-deleted-by-admin` 通知 —— admin 删别人笔记时给原作者写一条 (PR #12 一并做, 同时加了 `note-restored-by-admin` 给 restore 流) (原来源: commit `fd8eed6`, PR #10c → 在 PR #12 落地)
