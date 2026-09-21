# syntax=docker/dockerfile:1
#
# 把服务打进镜像 —— 适合部署到 NAS（群晖 Container Manager / 威联通 Container Station）、
# 树莓派、或任何有 Docker 的机器。配套文件：docker-compose.yml、.dockerignore。
#
# 两条不能改的地方：
#   1. 依赖必须在镜像里装。sharp 是**平台相关的原生包**，别指望复用本机的 node_modules。
#   2. 不要把 photos/ 或 .cache/ 打进镜像（见 .dockerignore），它们走 volume。
#
# 构建：
#   docker build -t my-baby-moments .
# 想省掉 ffmpeg（镜像能小 300MB 左右，代价是视频没有缩略图）：
#   docker build --build-arg WITH_FFMPEG=0 -t my-baby-moments .
#
# 注意：这里只把代码装进去，**不跑 npm ci 之外的任何构建**，也不做静态导出。
# 静态产物（dist/）没有鉴权，不是给这种场景用的；这里跑的是 `serve`。

FROM node:22-bookworm-slim

# ffmpeg 是 Linux 上**视频缩略图的唯一抽帧路径**。
# src/thumbs.mjs 的兜底链是 [ffmpeg → QuickLook]，而 QuickLook 在非 macOS 上第一行就
# 直接抛错（sips 同理）—— 也就是说 macOS 那两条兜底在 Linux 上都是空的。
# 不装也不会崩：视频会退化成设计好的瓦片，只是没有封面。
ARG WITH_FFMPEG=1
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    if [ "$WITH_FFMPEG" = "1" ]; then apt-get install -y --no-install-recommends ffmpeg; fi; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# 先只拷依赖清单：改业务代码不会让装依赖这一层失效
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
# scripts/ 不是运行必需的，跟着进去是为了让这两件事在容器里也能做：
#   node scripts/preflight.mjs   —— 部署前自检（实测 rename 原子性 / ffmpeg / 账号配置）
#   npm run verify               —— 在容器里复跑验证链，证明这个镜像本身是好的
# （verify:ui 需要 Chrome，容器里跑不了，属于预期。）
COPY scripts ./scripts

# ── 以下三样都在运行期挂进来，不在镜像里 ──────────────────────
#   /app/moments.config.mjs   配置（含口令哈希）
#   /data/photos              照片库
#   /data/cache               缩略图缓存 + 上传暂存区 + 上传锁
#
# ⚠️ photos 与 cache 必须在**同一个挂载点**下（compose 里挂成 /data 一个卷）。
#    原因见 docker-compose.yml 里的长注释：Linux 的 rename(2) 按挂载点判断，
#    跨挂载点会返回 EXDEV，上传入库就从"原子改名"退化成"复制+删除"。

EXPOSE 4310

# 监听 0.0.0.0 由配置里的 server.host 决定（默认 127.0.0.1，容器里必须改）。
# 不在这里用 CMD 覆盖，是为了让配置保持唯一真源。
CMD ["node", "src/cli.mjs", "serve"]
