---
name: ship
description: 收尾流程 —— 看 working tree → 必要时更新 CLAUDE.md / RENDERING-PITFALLS.md → 写 commit message → stage + commit。蘑菇说 "commit" / "/ship" 等都触发此 skill。
---

# Ship —— Quink 项目收尾流程

完成一组改动后用 `/ship` 触发，自动做以下事情：

## 1. 看 working tree

并行跑（**一条 message 内多个 Bash 调用**）：

- `git status`
- `git diff --stat`
- `git log --oneline -5`

如果工作树没改动 → 告诉蘑菇并退出，不创建空 commit。

## 2. 判断是否要更新文档

按 Quink 的 `CLAUDE.md` 维护规则（根 CLAUDE.md "CLAUDE.md 维护规则"段）：

| 改动类型 | 写到哪 |
|---|---|
| 跨包通用约定 / 多文件高频经验 | 根 `CLAUDE.md` |
| 某 package 内专属 | `packages/X/CLAUDE.md` |
| 某子目录专属 | 子目录 `CLAUDE.md` |
| DOM / CSS / Vue / 动画 / 渲染坑 | `RENDERING-PITFALLS.md` |
| 主题写完后改动少（图标系统等） | 普通 `.md`，根 `CLAUDE.md` 留指针 |
| **修 bug 但不引入新约定 / 不暴露新机制** | **不更新文档** |

判断"是否要更新"的关键问题：**这次改动有没有引入"后续开发可能再次遇到"的坑或约定**？是 → 更新；否 → 不更新。

如果要更新，先用 `Edit` / `Write` 改文档，再继续。

## 3. 写 commit message

参考 Quink 历史 commit 风格（`git log --oneline -5` 可看实例）：

- **第一行**：`feat:` / `fix:` / `docs:` + 简短描述，控制在 70 字符内
- **空行**
- **分段描述**：用"XX 名字:"开头（如 "A5 筛选时不显示编辑区:"），下面列具体改动
- **trade-off / root cause** 用一句话说清（如"接受 X 换 Y"）
- **末尾固定加** `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

例子参考最近几个 commit（`db53ca2` `9efe9aa` `beb9993`）。

## 4. Stage + commit

- `git add` **显式列出文件**（不用 `git add -A` / `.` 避免误传敏感 / 临时文件、运行时 lock 等）
- 用 HEREDOC 传 commit message：

```bash
git commit -m "$(cat <<'EOF'
feat: xxx

xxx 段:
- 改动 1
- 改动 2

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

commit 完简短报告：commit hash + 几个文件改了多少行。

## 约束

- **不主动 push / force / rebase**（蘑菇明确要才做）
- **不 amend**（永远新建 commit，hook 失败也是新 commit 不是 amend）
- **不跳过 hook**（不加 `--no-verify`）
- **CRLF warning 忽略**（Windows 项目正常）
- 改动里如果有 `.env` / `credentials.json` / 大 binary 文件 → 警告蘑菇，不自动 commit
