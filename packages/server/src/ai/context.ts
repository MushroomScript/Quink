// Chat v2 (FC) 重构后老的 RAG 路径已废弃, 整个文件只剩 estimateTokens 还在被 ai-chat.ts 用
// (用于截断对话历史保留 token 预算). 其余 searchRelevantNotes / buildNoteContext / resolveReferences 等
// 全部死代码已清, 不再维护.

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    if (/[一-鿿　-〿＀-￯]/.test(char)) {
      tokens += 1.5;
    } else if (/\s/.test(char)) {
      tokens += 0.25;
    } else {
      tokens += 0.5;
    }
  }
  return Math.ceil(tokens);
}
