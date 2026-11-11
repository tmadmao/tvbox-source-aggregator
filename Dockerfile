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
RUN npm run build:node

FROM node:20-alpine

ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
LABEL org.opencontainers.image.title="tvbox-aggregator" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_COMMIT}"
ENV APP_VERSION=${APP_VERSION}
ENV APP_COMMIT=${APP_COMMIT}

RUN apk add --no-cache python3 make g++ tzdata

# 同上：原生模块 rebuild 用镜像自带的 node headers，不依赖外网
ENV npm_config_nodedir=/usr/local

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --registry https://registry.npmmirror.com && \
    npm rebuild better-sqlite3 && \
    apk del python3 make g++
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data
VOLUME /app/data

ENV PORT=5678
ENV DATA_DIR=/app/data
ENV TZ=Asia/Shanghai
EXPOSE 5678

CMD ["node", "dist/server.js"]
