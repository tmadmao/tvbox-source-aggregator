FROM node:20-alpine AS builder

# 构建期把版本号/commit 打进 bundle：镜像里没有 .git，不带参数就会是 unknown。
ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ENV APP_VERSION=${APP_VERSION}
ENV APP_COMMIT=${APP_COMMIT}

RUN apk add --no-cache python3 make g++

# 官方 node 镜像自带头文件；显式指定可让 node-gyp 不再联网下载 node headers
# （NAS 到 nodejs.org 时通时不通，之前就卡在这一步）
ENV npm_config_nodedir=/usr/local

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --registry https://registry.npmmirror.com && \
    npm rebuild esbuild better-sqlite3
COPY . .
RUN npm run build:node && \
    npm prune --omit=dev --ignore-scripts

# ── 运行镜像 ───────────────────────────────────────────
# 不再装 python3/make/g++/tzdata：
#   · 原生模块直接从 builder 复制（同一个 node:20-alpine，ABI 一致），
#     省掉一次编译，也不再依赖 apk 网络；
#   · 时区用 POSIX 写法 CST-8（中国无夏令时），不依赖 /usr/share/zoneinfo。
FROM node:20-alpine

ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
LABEL org.opencontainers.image.title="tvbox-aggregator" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_COMMIT}"
ENV APP_VERSION=${APP_VERSION}
ENV APP_COMMIT=${APP_COMMIT}
ENV TZ=CST-8

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /app/data
VOLUME /app/data

ENV PORT=5678
ENV DATA_DIR=/app/data
EXPOSE 5678

CMD ["node", "dist/server.js"]
