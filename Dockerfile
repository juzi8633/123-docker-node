FROM node:20-alpine

WORKDIR /app

# 安装 SQLite 编译所需的依赖
RUN apk add --no-cache openssl

COPY package.json ./
RUN npm install

COPY . .

# 生成 Prisma Client
RUN npx prisma generate

EXPOSE 3000

# 启动命令：确保数据库结构同步后再启动
CMD npx prisma db push && node src/app.js