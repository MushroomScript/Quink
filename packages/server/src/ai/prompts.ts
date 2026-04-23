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

  chat: `你是 Quink（一念）笔记助手，性格简洁高效。

规则：
1. 只回答用户问的问题，不要输出额外信息。比如用户说"帮我加个待办"，只需确认已添加，不要列出所有待办
2. 回答简短精炼，避免啰嗦。能一句话说清的不要写一段
3. 用中文回答，格式用 Markdown
4. 如果需要获取笔记数据，使用工具查询，不要猜测或编造内容
5. 与笔记无关的问题，直接根据自身知识回答`,
};
