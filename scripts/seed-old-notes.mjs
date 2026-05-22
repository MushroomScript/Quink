// 直接 DB 插入 100 条"一个月前"的灵感测试数据,用于测试无限滚动 / 列表显示
//
// 用法 (PowerShell):
//   node scripts/seed-old-notes.mjs
//
// 默认目标用户: mushroom (id 3RVI_PbF7rqj). 改 USER_ID 环境变量可覆盖.
// 数据库路径: packages/server/quink.db

import Database from 'better-sqlite3';
import { resolve } from 'path';

const DB_PATH = resolve('packages/server/quink.db');
const USER_ID = process.env.USER_ID || '3RVI_PbF7rqj';
const COUNT = 100;

// 简版 nanoid: 12 位 random ID,字母数字 + _-,跟 server 用的 nanoid(12) 风格一致
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
function nanoid12() {
  let id = '';
  for (let i = 0; i < 12; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return id;
}

// 100 条测试内容池(随便写,不重复)
const CONTENTS = [
  '今天看到一棵树长得特别好看', '突然想试试新做法的咖啡', '地铁上听到一句话挺有意思',
  '想买个新键盘但又舍不得', '看了一部老电影还是很喜欢', '楼下新开了家店,改天去试试',
  '同事说的那句话有点道理', '周末打算去公园走走', '最近睡眠质量好像变好了',
  '想学一门新语言', '看完一本书顺手记一下', '路边的桂花开了',
  '想起小时候的某个画面', '今天的天空特别蓝', '突然怀念以前的同学',
  '想试试新的健身方法', '吃到一道很好吃的菜', '看到一段不错的代码',
  '想整理一下书架', '路上遇到一只很可爱的猫', '今天工作效率挺高',
  '想看看那个新出的展览', '听到一首很喜欢的歌', '想给家里换个新窗帘',
  '突然想到一个产品 idea', '今天朋友说的一句话', '想试试早起的生活',
  '看到一篇好文章', '想去远一点的地方走走', '今天天气特别好',
  '想买的那本书还没到货', '又重读了一遍那本书', '突然想吃妈妈做的菜',
  '想换个新的桌面壁纸', '今天的咖啡味道刚好', '想试试新发现的小餐厅',
  '工作上有个新想法', '看到一个有意思的设计', '想整理一下相册',
  '今天的会议挺顺利', '想去看的电影还在排队', '突然想给老朋友打个电话',
  '路上拍到一张好看的照片', '想试试新的写作风格', '今天读到一段印象深的话',
  '想换个新的工作习惯', '看到一个不错的开源项目', '想试试新的健康饮食',
  '今天遇到一件挺有意思的事', '想整理一下旧物', '路上看到一个挺有意思的招牌',
  '想试试新的笔记方法', '今天看到的一句广告挺有意思', '想去图书馆坐一下午',
  '突然想换一个发型', '路边小店的招牌挺有意思', '今天和家人聊得挺开心',
  '想试试录一段语音笔记', '看到一个很巧妙的设计', '想去某个老街走走',
  '今天的午饭味道还行', '想试试新的运动方式', '突然想到一句话挺有意思',
  '想换个工作环境的布置', '今天的代码改得挺顺', '想去看看那个小展',
  '路上听到的对话很有意思', '想试试新的睡眠时间', '今天读完了一本书',
  '想给朋友送个小礼物', '看到一个挺有创意的视频', '想去附近的公园散步',
  '今天试了新的工作方法', '想换一个手机壳', '突然想试试做菜',
  '路上看到一家有意思的店', '想去某个咖啡馆坐一下午', '今天工作时灵感不错',
  '想试试新的整理方法', '看到一个挺暖心的故事', '想去某个新开的地方',
  '今天和朋友聊到了未来', '想换个新的输入法', '突然想给自己买个礼物',
  '路上看到一只小狗很可爱', '想试试用语音来记笔记', '今天的运气挺好',
  '想去某个安静的地方待会儿', '看到一段挺感动的话', '想换个新的杯子',
  '今天突然想起一首老歌', '想试试用新的工具来工作', '看到了一个不错的活动',
  '想去参加那个分享会', '今天的代码运行得挺顺', '想换个新的电脑桌',
  '突然想做点不一样的事', '路上遇到一个老朋友', '想试试新的笔记应用',
  '今天的阳光特别好',
];

// 一个月前 ± 5 天范围内随机
const NOW = Date.now();
const ONE_MONTH = 30 * 24 * 3600 * 1000;
const FIVE_DAYS = 5 * 24 * 3600 * 1000;

function randomTimeAroundOneMonthAgo() {
  const offset = (Math.random() - 0.5) * 2 * FIVE_DAYS; // ±5 天
  return new Date(NOW - ONE_MONTH + offset).toISOString();
}

const db = new Database(DB_PATH);
const insert = db.prepare(`
  INSERT INTO notes (id, user_id, content, summary, category, tags, type, ai_processed, pinned, created_at, updated_at, deleted_at)
  VALUES (?, ?, ?, NULL, NULL, '[]', 'note', 1, 0, ?, ?, NULL)
`);

const tx = db.transaction(() => {
  for (let i = 0; i < COUNT; i++) {
    const id = nanoid12();
    const content = `测试 ${i + 1}: ${CONTENTS[i]}`;
    const time = randomTimeAroundOneMonthAgo();
    insert.run(id, USER_ID, content, time, time);
  }
});

tx();

const after = db.prepare('SELECT COUNT(*) as cnt FROM notes WHERE user_id = ? AND deleted_at IS NULL').get(USER_ID);
console.log(`Inserted ${COUNT} test notes. User ${USER_ID} now has ${after.cnt} total notes.`);

db.close();
