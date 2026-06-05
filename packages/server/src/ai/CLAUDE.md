# packages/server/src/ai CLAUDE.md

Quink 后端 AI 系统专属指引（`prompts.ts` / `client.ts` / `tools.ts` / `context.ts`）。本文件在 `packages/server/src/ai/` 子目录工作时自动加载。

改其他 server 路由（认证 / 数据库 / 文件上传等）不会加载本文件。如果改 server 顶层接口里间接调用了 AI 流程（如 `processNoteWithAi`），按需主动 read。

## AI 系统

- **多配置**：用户在 `ai_configs` 表创建命名的 AI 配置（provider/url/key/model）。
- **按功能绑定**：每个 AI 功能（auto_tag、auto_classify、auto_summary、polish、expand、write、chat）通过 `preferences.aiBindings` 绑定到具体配置。
- **提示词**：默认提示词在 `src/ai/prompts.ts`，用户自定义存在 `ai_prompts` 表。
- **AI 对话（v2）**：已重构为 Function Calling 模式。后端定义 10 个工具（`src/ai/tools.ts`），AI 自己决定调用哪个。支持原生 FC + 提示词降级两种模式。流式输出走 SSE。
- **思考模型**：支持 `<think>...</think>` 标签解析（DeepSeek-R1、QwQ 等），前端折叠展示。
- **自动处理**：创建笔记后异步触发 `processNoteWithAi()`（不阻塞）。3 个并发任务（tag / category / summary）各有独立开关 `prefs.autoTag` / `prefs.autoCategorize` / `prefs.autoSummary`，开关字段缺省视作 true（向后兼容）。summary 额外受 `prefs.autoSummaryMinLen` 阈值控制（纯文本长度 < 阈值不生成，过滤图片/附件 markdown 后算）。
- **自动分类的 `{categories}` 占位约定（2026-05-29 重写）**：`auto_classify` prompt 用 `{categories}` 占位符注入"用户当前分类列表"（`autoClassify` 在 `client.ts` 查 categories 表填）。AI 必须从列表里选，**后端校验 AI 返回值必须在列表内，否则强制 null**（防 AI 编造新分类）。注册时通过 `auth.ts` seed `DEFAULT_CATEGORIES`（工作 / 学习 / 生活 / 其他，"其他"是 AI 兜底）。**`processNoteWithAi` 不再"AI 返回新分类自动 insert"**——categories 表只在注册 seed / 用户手动新增时增长。老用户（0 分类）`autoClassify` 直接返回 null（不补 seed）。改自动分类行为先动 `prompts.ts` 的 `auto_classify` prompt + `client.ts` 的 `autoClassify` 校验逻辑。
- **AI 客户端**（`src/ai/client.ts`）：统一调用 OpenAI/Anthropic/Ollama，自动识别 URL 格式。
- **弱模型 / 量化模型适配**：本地 Ollama 上 qwen2.5-coder q4 这类小模型对 OpenAI Function Calling 协议支持差，第一轮 native FC 经常返回空 `tool_calls` + 直接编内容（"买菜/完成报告"这种训练样本）。`callAiWithToolLoop` 在 round 0 检测到 `toolCalls.length === 0 && !content.includes('<tool>')` 时强制降级到提示词模式重试，把 `TOOLS_PROMPT` 拼进 system 引导输出 `<tool>...</tool>`。
- **弱模型不会数数**：列表类工具（如 `get_todos`）必须在返回字符串开头直接拼好数量（"共 X 条（已完成 Y / 未完成 Z）："），不要指望 AI 自己 count。chat prompt 也明说"数量直接读开头那行，别重新数"。
- **chat prompt 三大块**：`prompts.ts` 的 chat 段定义了【强制规则】（询问待办/笔记/标签必须先调工具）、【工具返回的笔记数据格式】（ID/refId 不发给用户、引用 label 怎么读）、【汇总/分析处理方式】（置顶要标⭐、临近截止要提醒、末尾给观察）。改 chat 行为先动这里。
- **引用 label 透传给 AI**：`tools.ts` 的 `cleanContent` 把笔记里的引用块 `[label](?ref=xxx)` 转成 `「label」(refId:xxx)`，AI 直接看到被引笔记 ID，可调 `get_note(id=xxx)` 拿详情；prompt 里 refId 禁止发给用户。`search_notes` 同时 OR 搜 content + summary + tags，避免 label 只在 summary/tags 时漏检。
- **群共享 chat 上下文（PR #4）**：读类工具（`search_notes` / `get_recent_notes` / `get_todos` / `get_tags` / `get_stats`）都加 `scope` 参数（`mine` / `shared` / `all`，默认 `all`），走 `getVisibilityCondition(userId, scope)` helper 拼"我的 OR 别人共享给我所在 active 群"的 SQL。返回笔记列表的工具调 `fillAuthorNicknames(userId, notes)` 批量 join `users.nickname` 给非本人笔记填 `authorNickname`，`formatNote` 加 `作者:xxx` 字段透传给 AI 区分来源（本人笔记不带该字段）。`get_note` 不接 scope，按 id 拿后做"作者本人 OR `note_shares ∩ my_active_groups`"校验（跟 `routes/notes.ts` GET `/:id` 一致）。`get_voice_transcription` 复用 PR #3 文件授权链（audioName LIKE `notes.content` + `visibility='shared'` + note_shares + group_members）。**新加 chat 工具按这套模式做 scope + author**：列表类调 `fillAuthorNicknames`，单条按 id 校验 noteShares ∩ groups。chat prompt 同步告知 AI scope 用法 + `作者:` 字段语义。
- **`context.ts` 仅剩 `estimateTokens`**：v2 FC 重构后老 RAG 路径（`searchRelevantNotes` / `buildNoteContext` / `resolveReferences` / `resolveVoiceLinks`）全已清，整个文件只剩 `estimateTokens` 给 `ai-chat.ts` 用于截断历史对话保留 token 预算。改 AI chat 行为别去 context.ts 找，走 `tools.ts` + `prompts.ts`。
