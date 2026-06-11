<div align="center">

<img src="packages/web/public/quink-blueberry-192.png" width="120" alt="Quink Logo" />

# Quink · 一念

**一念之间，落笔即存** · **AI 自动整理，灵感不再走散**

带 AI 自动打标签 / 分类 / 摘要的个人笔记应用，多端通用

[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?style=flat-square&logo=vue.js&logoColor=white)](https://vuejs.org)
[![Electron](https://img.shields.io/badge/Electron-35-47848F?style=flat-square&logo=electron&logoColor=white)](https://electronjs.org)
[![Hono](https://img.shields.io/badge/Hono-4.7-FF6B35?style=flat-square&logo=hono&logoColor=white)](https://hono.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org)

</div>

---

## ✨ 为什么用 Quink

灵感稍纵即逝。打开传统笔记 app，找分类、选模板、写五分钟，等你写完，灵感早凉了。

Quink 把记录流程压到 **一个全局快捷键 + 一次回车**：

- 按下全局快捷键在任何应用里弹出输入窗口
- 写完一键即存
- 整理（打标签 / 归类 / 写摘要）交给 AI 后台异步完成
- 回头要找，自然语言问 AI 即可

剩下的功能，看下面。

---

## 🎯 核心特性

### 🚀 极速捕捉

- **全局快捷键 Capture** 任何应用里按下快捷键弹出 Vditor Markdown 编辑器，写完一键即存
- **快捷悬浮窗** 快捷键抓取选中文字弹操作菜单（翻译 / 续写 / 总结）
- **多种输入** 文字 / Markdown / 语音录制 / 图片 / 文件拖入 / 粘贴
- **快捷键全部可自定义**

### 🤖 AI 自动整理

笔记入库后**异步处理**（不阻塞保存）：

- **自动打标签** 3-5 个准确标签
- **自动分类** 根据你已有分类树智能归属
- **自动摘要** 长笔记自动 50 字摘要，列表卡片一眼看懂
- **可关可调** 每项独立开关，prompt 模板用户可编辑

**支持的 AI Provider**：

- OpenAI / Anthropic / DeepSeek / 通义 / 智谱 等任何 **OpenAI 兼容 API**
- **本地 Ollama** 完全离线模式可用

**多配置绑功能** "GPT-5.4-nano 跑标签 / Claude Sonnet 跑对话" 灵活组合，每个 AI 功能独立绑定不同的 provider。

### 💬 AI 对话查询

不是简单 RAG，是 **Function Calling v2**。AI 自带 10 个工具：

| 工具 | 用途 |
|---|---|
| `search_notes` | 全文 + 标签 + 日期复合搜索 |
| `get_note` | 拿单条详情 |
| `create_note` | 直接帮你写一条新笔记 |
| `update_note` | 修改现有笔记内容 |
| `delete_note` | 移动到回收站 |
| `list_categories` | 看你的分类树 |
| `list_tags` | 看热门标签 |
| `get_stats` | 拉时间段统计 |
| `... ` | 共 10 个 |

实际对话：

> 用户："我上个月写过关于 Docker 的笔记吗？"  
> AI 调用 `search_notes(keyword: "docker", month: "2026-05")` → 找到 3 条 → 用引用 chip 回复

支持 **流式输出** + **思考模型**（Claude / o1）展示推理过程。

### 👥 群组协作

- **邀请码加入**群组共享笔记
- **Fork 机制** 别人的笔记拿副本独立编辑，不影响原版
- **编辑权限分级** 「仅管理员可编辑」/「全员可编辑」
- **编辑请求 + 审批流** 无权限用户可申请，作者 / 群管理员审批
- **抢占式编辑锁** 5 分钟 TTL + 30 秒心跳续约，防多人撞改
- **乐观锁兜底** `version` 字段防极端 case
- **群成员 presence** 在线状态显示，可开启**隐身模式**

### 🔔 8 种通知渠道

按笔记 / 群组 / 通知类型**灵活路由**：

- 📱 **Bark** (iOS 推送)
- 💬 **Telegram Bot**
- ✉️ **Email** (SMTP)
- 🐦 **飞书机器人**
- 🌸 **钉钉机器人**
- 🐼 **企业微信机器人**
- 🪝 **自定义 Webhook**
- 🖥️ **浏览器原生通知**（Electron 弹 OS 通知）

支持 **RRULE 重复提醒**（每天 / 每周 / 每月 / 自定义间隔）。

### 📚 多端通用

| 端 | 路径 | 特性 |
|---|---|---|
| **Web** | `localhost:24888` | 浏览器随时访问，PWA 支持离线 |
| **Desktop** | Electron | 全局快捷键 / 系统托盘 / 拖文件入库 |
| **移动端** | 同 Web | 响应式布局，textarea 替换 Vditor，性能优先 |

### 🎨 极度可定制

- **7 套主题色** 蓝莓 / 薰衣草 / 薄荷 / 蜜桃 / 柠檬 / 云雾 / 深色
- **Bibata 鼠标光标** 7 主题对应 7 套定制光标，跟系统主题联动
- **显示比例** 75% - 200% 任选
- **卡片瀑布流** 自适应列数，宽度模式可选（像素 / 屏宽百分比）
- **全局快捷键自定义**
- **AI 人格风格** 6 种预设 + 自定义
- **暗色主题全适配** 所有硬编码颜色已加 dark variant

---

## 📷 截图

> 截图待补

---

## 🚀 部署

Quink 服务端 + Web 端打包到一个 Docker 镜像里。任意有 Docker 的设备（NAS / Mac mini / Linux VPS / Windows + Docker Desktop / 树莓派）都能跑。

### 方式 A：拉预构建镜像（推荐, 30 秒可用）

每次 main 分支有新 commit, GitHub Actions 自动 build 镜像推到 GHCR。用户拉镜像直接跑, 不用本地 build。

```bash
git clone https://github.com/MushroomScript/Quink.git
cd Quink
cp .env.example .env
nano .env  # 改 .env (见下面"必填配置")

mkdir -p quink-data
# Linux/macOS: sudo chown 1000:1000 quink-data  (容器内非 root uid 1000 跑)

docker compose up -d  # 自动 pull GHCR 镜像 + 起容器
```

**必填配置（`.env`）**：

```ini
# 1. JWT 签名密钥, 必改强随机串. 不改 = 任何人能伪造登录 token
#    生成方法 (Linux/macOS):     openssl rand -hex 32
#    生成方法 (Windows PS):      [Convert]::ToHexString([byte[]] @(1..32 | ForEach { Get-Random -Max 256 }))
JWT_SECRET=改成你生成的强随机串

# 2. 用 GHCR 预构建镜像 (推荐). 注释掉走方式 B 本地 build
QUINK_IMAGE=ghcr.io/mushroomscript/quink:latest
```

浏览器打开 `http://<server-ip>:38999` 注册首个账号即可使用。

### 方式 B：本地 build（开发者 / 想改代码 / 国内 GHCR 拉不到）

跟方式 A 一样, 但 `.env` 里**注释掉 `QUINK_IMAGE`** 那行。`docker compose up -d` 自动 fallback 到本地 build, 首次 15-25 分钟。

**中国大陆用户加速 build**：`.env` 取消注释这两行:

```ini
APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
NPM_MIRROR=https://registry.npmmirror.com
```

### 升级

```bash
git pull               # 拉新代码 (Dockerfile / docker-compose 可能改)
docker compose pull    # 方式 A: 拉新镜像
# docker compose build # 方式 B: 本地重 build
docker compose up -d   # 重启容器用新镜像
```

SQLite schema 启动自动迁移，所有版本兼容老 DB（每个迁移都 try-catch 包着 + `WHERE` 限制反复跑无害）。**升级前务必备份**：

```bash
tar -czf quink-backup-$(date +%F).tar.gz quink-data/
```

### 国内 docker pull 加速

GHCR (`ghcr.io`) 国内访问看运气。慢的话可在 Docker Desktop / `/etc/docker/daemon.json` 配 registry mirror。注意 GHCR 不在传统 dockerhub mirror 覆盖范围, 建议直接挂代理 pull 一次（镜像本地有了之后启停容器都不再走网络）。

### 迁移到其他机器

把 `quink-data/` 整个目录复制过去就行（SQLite DB + uploads + 缩略图都在内）。同版本镜像直接跑，不同版本启动会自动迁移。

### 反向代理 + HTTPS（可选）

公网部署建议 nginx / caddy 反代加 HTTPS。**SSE 长连接** 必须特殊配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:38999;
    proxy_buffering off;          # SSE 必须关 buffering
    proxy_read_timeout 24h;       # SSE 长连接, 不能短超时
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

caddy 用户更简单（自动 SSE 适配 + Let's Encrypt 证书）：

```caddy
quink.yourdomain.com {
    reverse_proxy 127.0.0.1:38999
}
```

### 配置参数（.env）

| 变量 | 用途 | 必填 |
|---|---|---|
| `JWT_SECRET` | JWT 签名密钥, 必改强随机串 | **是** |
| `QUINK_ALLOWED_ORIGINS` | CORS 白名单. 默认 `*`. 公网部署填具体域名收紧 | 否 |

完整 env 列表见 `packages/server/CLAUDE.md` "环境变量约定" 段。

### 从源码运行（开发者）

```bash
git clone https://github.com/MushroomScript/Quink.git
cd Quink
pnpm install
pnpm run dev:server   # 起后端 (38999)
pnpm run dev:web      # 起前端 (24888, 另一终端)
```

需要 Node.js >= 20 + pnpm。

### 桌面客户端（alpha）

Electron 桌面客户端三平台安装包通过 GitHub Actions 跨平台 build:

- **稳定版本**: 打 tag `desktop-v0.1.0-alpha` push → 三平台 runner (windows-latest / macos-latest / ubuntu-latest) 并行 build → 自动发布到 [Releases](https://github.com/MushroomScript/Quink/releases)
- **开发测试**: 维护者去 [Actions](https://github.com/MushroomScript/Quink/actions) 页面手动 "Run workflow" 触发, 产物在 Actions Artifacts 下载 (保留 30 天)

**alpha 限制**:

- **macOS** 未签名（没 Apple 开发者账号）: 首次打开右键 → 打开 → 继续。macOS 15+ 进一步要求 系统设置 → 隐私 → 点允许
- **Windows** 未签名: 首次打开有 SmartScreen 警告 → 更多信息 → 仍要运行
- **客户端默认连本机 `localhost:38999`**: 需要本机用 Docker 跑 Quink server (见上面"部署"段). 远程 / 局域网 server 支持等下一版本加 onboarding UI

桌面端独有功能（相比浏览器）:

- 全局快捷键弹出快速记录窗口 (Capture)
- 全局快捷键弹出 AI 对话 (AiChat)
- 全局快捷键抓取选中文字弹悬浮操作菜单 (Float)
- 系统托盘常驻
- 拖文件入主窗口 = 入库
- OS 原生通知

不需要这些功能的用户直接浏览器开 `http://<server>:38999` 即可。

---

## 🏗 技术栈

```
┌──────────────────────────────────────────────────────────────┐
│  Web  (Vue 3.5 + Vite 6 + TailwindCSS 3 + Vditor + ECharts)  │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTP + SSE
┌──────────────────────────▼───────────────────────────────────┐
│  Server  (Hono 4 + Drizzle ORM + SQLite + TypeScript 5.7)    │
└──────────────────────────┬───────────────────────────────────┘
                           │ Provider-agnostic
                  ┌────────▼────────┐
                  │  AI Providers   │
                  │  OpenAI / Claude / Ollama / DeepSeek / ... │
                  └─────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Desktop  (Electron 35 + uIOhook 全局快捷键 + Rust native)    │
└──────────────────────────────────────────────────────────────┘
```

### 后端 `packages/server`

| 工具 | 用途 |
|---|---|
| **Hono** ^4.7 | 边缘原生 web 框架 |
| **better-sqlite3** ^11.8 | 同步 SQLite 驱动 |
| **Drizzle ORM** ^0.39 | 类型安全 ORM + 自动 snake_case ↔ camelCase 映射 |
| **sharp** + **libheif-js** | 图片处理 + HEIC 解码 |
| **archiver** + **jszip** | 数据导入 / 导出 |
| **nodemailer** | SMTP 邮件 |
| **rrule** | RFC 5545 重复提醒规则 |
| **zod** | 请求校验 |
| **pinyin-pro** | 中文拼音搜索 |

### 前端 `packages/web`

| 工具 | 用途 |
|---|---|
| **Vue** 3.5 | Composition API + `<script setup>` |
| **Vite** 6 | 开发服务器 + HMR |
| **TailwindCSS** 3 | 工具类 CSS + CSS 变量主题切换 |
| **Vditor** ^3.11 | Markdown 编辑器（IR 模式） |
| **ECharts** 6 + **vue-echarts** | 统计图表 / 热力图 |
| **Pinia** 3 | 状态管理 |
| **vue-router** 4 | 路由 |
| **@phosphor-icons/vue** | 全套图标系统 |
| **@vueuse/core** | composable 工具 |
| **pdfjs-dist** | PDF 缩略图 |

### 桌面 `packages/desktop`

| 工具 | 用途 |
|---|---|
| **Electron** 35 | 跨平台桌面框架 |
| **uiohook-napi** | 全局快捷键监听 |
| **electron-store** | 配置持久化 |

### 原生 `packages/native` (Rust)

自研 Rust 模块：UI Automation 抓取选中文字 + Windows hook 兜底（悬浮窗特性依赖）。

---

## 📂 项目结构

```
Quink/
├── packages/
│   ├── server/                # Hono 后端 API
│   │   └── src/
│   │       ├── routes/        # API endpoints
│   │       ├── ai/            # AI 系统（FC v2 / prompts / tools）
│   │       ├── reminder/      # 8 adapter 通知系统
│   │       ├── db/            # Drizzle schema + 启动自动迁移
│   │       └── utils/         # 审计日志 / 缩略图 / 通知工具
│   ├── web/                   # Vue 3 前端
│   │   └── src/
│   │       ├── views/         # 主视图（灵感/笔记/待办/AI/群组/统计/资源/...）
│   │       ├── components/    # NoteCard / TopBar / Sidebar / RichEditor / ...
│   │       ├── stores/        # Pinia stores（notes / auth）
│   │       ├── composables/   # useMasonry / useInfiniteScroll / ...
│   │       └── utils/         # cardDnd / fileUrl / sse / ...
│   ├── desktop/               # Electron 桌面壳
│   │   └── src/
│   │       ├── main.ts            # 主进程
│   │       ├── preload-main.ts    # 主窗口 preload
│   │       ├── preload.ts         # 快捷窗口 preload
│   │       ├── shortcuts.ts       # 全局快捷键注册
│   │       └── tray-icon.ts       # 系统托盘
│   └── native/                # Rust native (UIA + windows hook)
└── package.json               # pnpm monorepo 根
```

---

## 🤝 贡献

Quink 是个人项目，开发节奏取决于作者灵感。欢迎 issue 跟 PR：

- 🐛 **报 bug** 开 issue 描述复现步骤
- 💡 **建议特性** 开 issue 讨论先
- 🛠️ **PR** 大改动请先开 issue 对齐方向，避免重复工作
- 🎨 **代码风格** 贴近现有代码，不引入新约定

## 📄 License

[MIT](LICENSE) © 2026 Mushroom

---

<div align="center">

**Made with ❤️ by Mushroom**

</div>
