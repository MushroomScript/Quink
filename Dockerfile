# syntax=docker/dockerfile:1.6
# Quink 一键自部署镜像
#
# 用法 (用户视角):
#   git clone <repo> && cd quink
#   docker compose up -d
#   浏览器打开 http://<server-ip>:38999
#
# 镜像两阶段:
#   1. builder: 装 build tools + 全量依赖 + build web + build server
#   2. runtime: 只装运行时系统库 + 复制 dist + node_modules. 镜像 ~600MB (主要 native 模块占用)
#
# 注意: monorepo 内 desktop 包 (electron + uiohook-napi) 安装时会下载 ~150MB,
# server 部署不需要. 用 pnpm install --filter 跳过节省 build 时间跟镜像

# 全局 ARG: 中国大陆用户加速 build (在 .env 设 APT_MIRROR / NPM_MIRROR 走清华 / 阿里源)
# 默认空 = 走官方源 (国外用户 / 海外服务器 build 时正常)
ARG APT_MIRROR=""
ARG NPM_MIRROR=""

# ============ Stage 1: build ============
FROM node:22-bookworm-slim AS builder

# ARG 跨 stage 必须 redeclare (docker 规范)
ARG APT_MIRROR
ARG NPM_MIRROR

# native 模块编译依赖:
# - python3 + build-essential: better-sqlite3 编译
# - pkg-config + libvips-dev: sharp 编译 (Debian libvips 8.14)
# libheif-js 是纯 WASM, jpeg-js 纯 JS, 都不需要系统库
# APT_MIRROR 设了走清华/阿里源. BuildKit cache mount 缓存 .deb 下载 (单包失败 retry 不重下).
# 整个 install 用 for-retry loop 包 3 次, 防偶发抖动让 RUN 整体 fail
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    if [ -n "$APT_MIRROR" ]; then \
        sed -i "s|deb.debian.org/debian|${APT_MIRROR}/debian|g; s|security.debian.org/debian-security|${APT_MIRROR}/debian-security|g" /etc/apt/sources.list.d/debian.sources; \
    fi && \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get -o Acquire::Retries=10 update && \
    for i in 1 2 3; do \
        apt-get -o Acquire::Retries=10 install -y --no-install-recommends \
            python3 build-essential pkg-config libvips-dev \
        && break; \
        echo ">>> apt install failed, retry $i"; sleep 5; \
    done

# pnpm 11 引入了严格 onlyBuiltDependencies 校验 + monorepo 行为变化, 装不出来. pin 到 pnpm 10
# NPM_MIRROR 设了让 npm 也走 mirror, 否则 pnpm 包从 npmjs 拉国内慢
RUN if [ -n "$NPM_MIRROR" ]; then npm config set registry $NPM_MIRROR -g; fi && \
    npm install -g pnpm@10

WORKDIR /build

# 优先 copy manifest 让 docker layer cache 起作用 (源码改但依赖没改时跳过 install)
# desktop / native 整个被 .dockerignore 排了不 COPY, pnpm workspace 扫不到自然跳过其依赖 (electron / uiohook)
COPY package.json pnpm-workspace.yaml .npmrc ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/

# pnpm-lock.yaml 当前不在 git (蘑菇决定), 用 install 兜底
# NPM_MIRROR 设了走 npmmirror 加速 (中国用户)
RUN if [ -n "$NPM_MIRROR" ]; then \
        echo "registry=$NPM_MIRROR" >> .npmrc; \
    fi && \
    pnpm install --no-frozen-lockfile

# 复制源码 (排除 desktop, 不需要)
COPY tsconfig.base.json ./
COPY packages/server ./packages/server
COPY packages/web ./packages/web

# Vditor 静态文件从 node_modules 复制到 web public (源码 .gitignore 排除, 必须 build 时再做)
RUN mkdir -p packages/web/public/vditor \
    && cp -r node_modules/vditor/dist packages/web/public/vditor/dist

# build
RUN pnpm --filter @quink/server build \
    && pnpm --filter @quink/web build

# ============ Stage 2: runtime ============
FROM node:22-bookworm-slim AS runtime

ARG APT_MIRROR

# 运行时只需要 libvips (sharp 用), 编译工具 / dev headers 不需要
# cache mount + retry loop 同 builder stage
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    if [ -n "$APT_MIRROR" ]; then \
        sed -i "s|deb.debian.org/debian|${APT_MIRROR}/debian|g; s|security.debian.org/debian-security|${APT_MIRROR}/debian-security|g" /etc/apt/sources.list.d/debian.sources; \
    fi && \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get -o Acquire::Retries=10 update && \
    for i in 1 2 3; do \
        apt-get -o Acquire::Retries=10 install -y --no-install-recommends \
            libvips \
        && break; \
        echo ">>> apt install failed, retry $i"; sleep 5; \
    done

WORKDIR /app

# 复制 build stage 产物
# 注意 node_modules 是从 builder 那边的 monorepo 根复制. shamefully-hoist 把所有依赖
# 提升到根 node_modules, 让 server 包能直接 import 到. 不能只复制 packages/server/node_modules
COPY --from=builder /build/packages/server/dist ./packages/server/dist
COPY --from=builder /build/packages/server/package.json ./packages/server/
COPY --from=builder /build/packages/web/dist ./web-dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./

# 默认 env (docker-compose 可覆盖)
ENV QUINK_DATA_DIR=/data \
    QUINK_WEB_DIST=/app/web-dist \
    QUINK_PORT=38999 \
    QUINK_HOST=0.0.0.0 \
    NODE_ENV=production

# 数据目录用户必须 volume 挂出去, 否则容器重建数据丢
VOLUME ["/data"]

EXPOSE 38999

# 容器内非 root 用户跑更安全. node:20-bookworm-slim 自带 node 用户 (uid 1000)
# /data volume 权限挂载方负责 (docker-compose / 用户手动 mkdir + chown)
USER node

# 健康检查: 容器编排可用 (docker-compose / k8s 都识别)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:38999/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
