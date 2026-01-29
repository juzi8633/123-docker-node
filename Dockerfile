# ==========================================
# 阶段 1: 前端构建 (Builder)
# ==========================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app/ui

# 只复制 package 文件，利用缓存
COPY ui/package*.json ./

# 安装所有依赖 (包括 devDependencies，因为构建需要 Vite)
# 使用 npm ci 比 npm install 更快更干净
RUN npm install --registry=https://registry.npmmirror.com

COPY ui/ .
RUN npm run build

# ==========================================
# 阶段 2: 最终运行时 (Runner)
# ==========================================
FROM node:20-alpine

# 安装基础运行库 (Prisma 在 Alpine 上需要 openssl)
# --no-cache 不会保留 apk 缓存，减小体积
RUN apk add --no-cache openssl curl

WORKDIR /app

# 1. 先只复制后端依赖描述文件
COPY package*.json ./

# 2. [关键优化] 只安装生产依赖
# --omit=dev: 不安装 eslint, nodemon 等开发依赖
# --ignore-scripts: 跳过部分非必要的脚本
RUN npm install --omit=dev --registry=https://registry.npmmirror.com && \
    npm cache clean --force

# 3. 复制后端源码 (利用 .dockerignore 排除 node_modules)
COPY src/ ./src/
COPY prisma/ ./prisma/

# 4. 从第一阶段复制构建好的前端静态文件
COPY --from=frontend-builder /app/ui/dist ./public

# 5. 生成 Prisma Client (这一步会下载针对 Alpine 的 Query Engine)
# 这一步产生的文件在 node_modules/.prisma 下
RUN npx prisma generate

# 6. 设置环境变量
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATABASE_URL="file:/data/prod.db"

EXPOSE 3000

CMD ["/bin/sh", "-c", "npx prisma db push && node src/app.js"]