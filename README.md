<div align="center">

<img src="packages/web/public/quink-blueberry-192.png" width="120" alt="Quink Logo" />

# Quink · 一念

**一念之间，落笔即存** · **AI 自动整理，灵感不再走散**

带 AI 自动打标签 / 分类 / 摘要的个人笔记应用，多端通用

[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?style=flat-square&logo=vue.js&logoColor=white)](https://vuejs.org)
[![Electron](https://img.shields.io/badge/Electron-35-47848F?style=flat-square&logo=electron&logoColor=white)](https://electronjs.org)
[![Hono](https://img.shields.io/badge/Hono-4.7-FF6B35?style=flat-square&logo=hono&logoColor=white)](https://hono.dev)

<br/>

**🤖 全项目 100% 由 AI 开发 · 0 行手写代码（作者也不会写）**

</div>

---

## ✨ 为什么用 Quink

灵感稍纵即逝。传统笔记 app 找分类、选模板、写五分钟，等你写完灵感早凉了。

Quink 把记录压到 **一个全局快捷键 + 一次回车**：在任何应用里按快捷键弹出输入窗，写完即存，打标签 / 归类 / 摘要交给 AI 后台异步完成，回头要找自然语言问 AI 即可。

---

## 🎯 核心特性

- **🚀 极速捕捉** — 全局快捷键在任何应用弹出 Markdown 编辑器，写完即存；快捷键抓取选中文字弹操作菜单；文字 / 语音 / 图片 / 文件拖入都支持
- **🤖 AI 自动整理** — 笔记入库后异步打标签 / 分类 / 摘要，每项独立开关。支持任何 OpenAI 兼容 API（OpenAI / Claude / DeepSeek / 通义 / 智谱）+ 本地 Ollama 离线
- **💬 AI 对话查询** — Function Calling，AI 自带 10 个工具（搜索 / 创建 / 修改 / 统计…），流式输出 + 思考模型推理过程
- **👥 群组协作** — 邀请码加入、Fork 副本独立编辑、编辑权限分级 + 审批流、抢占式编辑锁
- **🔔 8 种通知渠道** — Bark / Telegram / Email / 飞书 / 钉钉 / 企业微信 / Webhook / 浏览器通知，支持 RRULE 重复提醒
- **🎨 极度可定制** — 7 套主题 + 定制鼠标光标、显示比例、瀑布流、AI 人格、暗色全适配

多端通用：浏览器 / PWA、Electron 桌面端（全局快捷键 + 托盘）、移动端响应式。

---

## 🚀 部署服务器（Docker）

服务端 + Web 端打包成一个 Docker 镜像，任意有 Docker 的设备（NAS / Linux VPS / Mac mini / Windows）都能跑。

```bash
git clone https://github.com/MushroomScript/Quink.git && cd Quink
cp .env.example .env          # 必改 JWT_SECRET（openssl rand -hex 32 生成）
mkdir -p quink-data
docker compose up -d          # 自动拉镜像 + 起容器
```

浏览器打开 `http://<server-ip>:38999` 注册首个账号即可。

- **升级**：`git pull && docker compose pull && docker compose up -d`
- **备份 / 迁移**：把 `quink-data/` 整个目录拷走即可（SQLite + uploads + 缩略图都在内）
- **公网部署**：建议 nginx / caddy 反代加 HTTPS。SSE 长连接的 nginx 要 `proxy_buffering off` + `proxy_read_timeout 24h`
- **备案号**（中国大陆公网部署）：`.env` 里填 `QUINK_ICP_BEIAN` / `QUINK_POLICE_BEIAN`，登录页底部自动展示并链到官方查询页；不填则不显示。**只能填你自己申请下来的号**
- **完整配置**：`.env` 里 `JWT_SECRET`（必填）+ `QUINK_ALLOWED_ORIGINS`（CORS 白名单，默认 `*`）。其余 env 见 `packages/server/CLAUDE.md`

> 不想用 Docker 也可从源码跑：`pnpm install` → `pnpm --filter @quink/web build` → 设 `QUINK_WEB_DIST` 起 server。需要 Node 20+。

---

## 💻 桌面客户端

桌面端 **自带后端 + 本地 SQLite**，下载安装包**双击即用，不需要装 Docker / 跑 server**。启动时自动拉起内嵌的 server，数据落系统目录（重装不丢）。

| 平台 | 安装包 |
|---|---|
| Windows | `Quink-<版本>-x64-setup.exe`（安装版）/ `Quink-<版本>-x64.zip`（绿色免安装） |
| macOS (Apple Silicon) | `Quink-<版本>-arm64.dmg` |

首次启动会让你选服务器模式：**本机**（自带后端，可勾「对局域网开放」+ 自定义端口让其他设备访问）或 **远程**（连已部署的 Quink 服务器）。托盘菜单可随时「切换服务器」。

桌面端独有：全局快捷键（快速记录 / AI 对话 / 抓取选中）、系统托盘常驻、拖文件入库、OS 原生通知。

> **未签名提示**：macOS 首次打开右键 → 打开；Windows SmartScreen → 更多信息 → 仍要运行。macOS 全局快捷键需在 系统设置 → 隐私与安全性 → 辅助功能 给 Quink 打勾。
>
> Intel Mac / Linux 桌面包暂不提供，走 Docker 或浏览器访问。

---

## 🛠 从源码开发

```bash
git clone https://github.com/MushroomScript/Quink.git && cd Quink
pnpm install
pnpm run dev:server   # 后端 (38999)
pnpm run dev:web      # 前端 (24888，另一终端)
```

技术栈：Vue 3.5 + Vite 6 + TailwindCSS（前端）/ Hono 4 + Drizzle ORM + SQLite（后端）/ Electron 35 + uiohook-napi（桌面）。

---

## 🤝 贡献 & License

个人项目，欢迎 issue / PR（大改动先开 issue 对齐方向，代码风格贴近现有）。

[MIT](LICENSE) © 2026 Mushroom

<div align="center">

**Made with ❤️ by Mushroom**

</div>
