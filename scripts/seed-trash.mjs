// 用法: node scripts/seed-trash.mjs <token>
//
// 创建 12 条测试笔记 (4 type × 3) 并全部软删除到回收站，用于测试恢复动画飞向不同 sidebar 菜单项。
//
// 拿 token:
//   1. 浏览器登录 Quink
//   2. F12 打开 devtools → Console → 输入: localStorage.getItem('quink_token')
//   3. 复制返回的字符串（不含两端引号）
//
// 运行（PowerShell）:
//   node scripts/seed-trash.mjs eyJhbGc...
//
// 注：默认后端地址 http://localhost:38999。改 API_BASE 环境变量可覆盖。

const API = (process.env.API_BASE || 'http://localhost:38999') + '/api';
const token = process.argv[2];

if (!token) {
  console.error('错误：缺少 token 参数');
  console.error('用法: node scripts/seed-trash.mjs <token>');
  console.error('token 拿法：浏览器登录 → F12 Console → localStorage.getItem("quink_token")');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
};

// 12 条 = 3 type × 4 条 (PR #8 命名重整: quink=灵感, note=笔记, todo=待办. link 类型已废弃)
const notes = [
  // type='quink' → 飞向"灵感" (/quink)
  { type: 'quink', content: '# 周末计划\n\n- 看完《沙丘 2》\n- 整理书架\n- 给妈妈打电话', tags: ['生活', '周末'] },
  { type: 'quink', content: '突然想到一个 idea：把每天看到的好句子拍照保存，变成自己的灵感库', tags: ['创意'] },
  { type: 'quink', content: '最近在读的书：**《零售的本质》** 强推。\n\n核心一句话：「顾客需求驱动一切。」', tags: ['读书'] },
  { type: 'quink', content: '推荐链接：https://www.anthropic.com/news/claude-4 \nClaude 4 发布', tags: ['AI'] },

  // type='todo' → 飞向"待办" (/todos)
  { type: 'todo', content: '回复 张三 关于合同的邮件' },
  { type: 'todo', content: '下周三前完成季度报告' },
  { type: 'todo', content: '买猫粮（友好的伙伴 鸡肉味）' },
  { type: 'todo', content: '订下周四 18:00 的牙医' },

  // type='note' → 飞向"笔记" (/notes)
  { type: 'note', content: '```ts\nconst delay = (ms) => new Promise(r => setTimeout(r, ms));\n```' },
  { type: 'note', content: '```sh\ngit log --oneline --graph --all | head -20\n```' },
  { type: 'note', content: '```py\ndef debounce(wait):\n    timer = None\n    # 实现略\n```' },
  { type: 'note', content: '```css\n.notes-masonry {\n  column-count: 3;\n  column-gap: 14px;\n}\n```' },
];

async function createAndTrash(note) {
  const createRes = await fetch(`${API}/notes`, {
    method: 'POST',
    headers,
    body: JSON.stringify(note),
  });
  if (!createRes.ok) {
    console.error(`  [失败] 创建 ${note.type}: HTTP ${createRes.status}`);
    return false;
  }
  const { data: created } = await createRes.json();

  const delRes = await fetch(`${API}/notes/${created.id}`, { method: 'DELETE', headers });
  if (!delRes.ok) {
    console.error(`  [失败] 删除 ${created.id}: HTTP ${delRes.status}`);
    return false;
  }

  const preview = note.content.split('\n')[0].slice(0, 28);
  console.log(`  [ok] ${note.type.padEnd(8)} ${preview}`);
  return true;
}

(async () => {
  console.log(`目标: ${API}`);
  console.log(`写入 ${notes.length} 条测试数据到回收站...\n`);
  let ok = 0;
  for (const n of notes) {
    if (await createAndTrash(n)) ok++;
  }
  console.log(`\n完成: ${ok}/${notes.length} 条已落到回收站`);
  if (ok < notes.length) process.exit(1);
})();
