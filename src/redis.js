import Redis from 'ioredis';
import dotenv from 'dotenv'; // [新增]
dotenv.config();

// [修复] 提取基础连接配置并导出，供 Queue 模块复用
// 避免 queue.js 中重复解析环境变量导致的配置不一致
export const REDIS_CONNECTION_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined, 
};

// 创建全局 Redis 客户端实例
// 这里的配置对应 docker-compose.yml 中的 service 名称
const redis = new Redis({
  ...REDIS_CONNECTION_CONFIG, // 复用配置
  retryStrategy: (times) => {
    // 自动重连策略
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: null // 配合 BullMQ 必须设置
});

redis.on('error', (err) => {
  console.error('[Redis] Connection Error:', err);
});

redis.on('connect', () => {
  console.log('[Redis] Connected successfully');
});

export default redis;
