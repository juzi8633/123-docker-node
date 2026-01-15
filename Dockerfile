# ==========================================
# Stage 1: 构建前端 (Builder)
# ==========================================
FROM node:20-alpine AS frontend-builder

# 设置前端工作目录
WORKDIR /app/ui

# 1. 单独复制 package.json 以利用 Docker 缓存
COPY ui/package*.json ./

# 2. 安装前端依赖
# 如果国内网络慢，可以加 --registry=https://registry.npmmirror.com
RUN npm install

# 3. 复制前端源代码
COPY ui/ .

# 4. 执行构建 (生成 dist 目录)
RUN npm run build


# ==========================================
# Stage 2: 构建最终镜像 (Runner)
# ==========================================
FROM node:20-alpine

# 安装基础工具 (比如 openssl 是 Prisma 必须的)
RUN apk add --no-cache openssl

WORKDIR /app

# 1. 复制后端 package.json (根目录的)
COPY package*.json ./

# 2. 安装后端生产依赖
RUN npm install --production

# 3. 复制后端源码
COPY src/ ./src/
COPY prisma/ ./prisma/
COPY scripts/ ./scripts/ 
# 如果有其他根目录文件(如 db.js 如果不在 src 下)也要复制

# 4. [关键] 从第一阶段复制构建好的前端文件到 public 目录
COPY --from=frontend-builder /app/ui/dist ./public

# 5. 生成 Prisma Client
RUN npx prisma generate

# 6. 暴露端口
EXPOSE 3000

# 7. 环境变量默认值 (运行时可覆盖)
ENV NODE_ENV=production
ENV HOST=0.0.0.0
# 数据库路径建议指向挂载卷 /data
ENV DATABASE_URL="file:/data/prod.db"

# 8. 启动命令
CMD ["node", "src/app.js"]