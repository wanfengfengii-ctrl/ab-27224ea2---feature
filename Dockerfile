# syntax=docker/dockerfile:1

# ---------- 一次性校核服务 ----------
# 运行单元测试、构建与判定冒烟（遮挡 + 跟踪角速度），随容器退出并以退出码报告结果。
FROM node:20-alpine AS verify
WORKDIR /app
COPY package.json ./
COPY index.html styles.css ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
CMD ["node", "scripts/verify.js"]

# ---------- Web 服务 ----------
# 构建 dist/ 后以零依赖静态服务器运行，自带健康检查。
FROM node:20-alpine AS web
WORKDIR /app
COPY package.json ./
COPY index.html styles.css ./
COPY src ./src
COPY scripts ./scripts
RUN node scripts/build.js
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "scripts/serve.js", "dist"]
