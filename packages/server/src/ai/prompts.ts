export const AI_FEATURES = ['auto_tag', 'auto_classify', 'polish', 'expand', 'write', 'chat'] as const;
export type AiFeature = typeof AI_FEATURES[number];

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
  auto_tag: '自动标签',
  auto_classify: '自动分类',
  polish: 'AI 润色',
  expand: 'AI 扩充',
  write: 'AI 写文',
  chat: 'AI 对话',
};

export const DEFAULT_PROMPTS: Record<AiFeature, string> = {
  auto_tag: `分析以下笔记内容，提取 3-5 个最相关的关键标签。
要求：
- 标签应简洁（2-4个字）
- 涵盖主题、技术、领域等维度
- 仅返回 JSON 数组格式，如 ["标签1", "标签2", "标签3"]
- 不要返回任何其他内容

笔记内容：
{content}`,

  auto_classify: `分析以下笔记内容，判断它最适合的分类。
可选分类：编程/思路、编程/踩坑、编程/命令、编程/部署、待办、生活、工作、学习、其他
要求：
- 仅返回一个分类名称
- 不要返回任何其他内容

笔记内容：
{content}`,

  polish: `请润色以下内容，使其语言更流畅、表达更专业。
要求：
- 保持原意不变
- 保持原有格式结构（标题、列表、代码块、表格等）
- 如果内容中有图片标记，保持图片位置不变
- 直接返回润色后的内容，不要添加说明

原文：
{content}`,

  expand: `请扩充以下内容，补充更多细节、示例和说明。
要求：
- 围绕原文主题展开，不偏离
- 保持原有格式结构
- 如果内容中有图片标记，保持图片位置不变
- 表格内容可以补充更多行
- 直接返回扩充后的内容，不要添加说明

原文：
{content}`,

  write: `请根据以下主题或大纲撰写一篇完整的内容。
要求：
- 结构清晰，有标题和段落
- 内容充实，有观点有论据
- 语言流畅自然
- 直接返回文章内容

主题/大纲：
{content}`,

  chat: `你是 Quink（一念）笔记助手。用户可能基于笔记内容提问，也可能问与笔记无关的问题。

规则：
1. 如果提供了笔记上下文，优先基于笔记回答
2. 如果笔记中没有相关信息，或用户的问题与笔记无关，根据你自己的知识回答
3. 回答使用中文，格式用 Markdown
4. 如果引用了某条笔记的内容，在回答末尾标注来源`,
};
