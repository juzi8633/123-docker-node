import Redis from 'ioredis';
import dotenv from 'dotenv'; // [新增]
dotenv.config();

// 创建全局 Redis 客户端实例
// 这里的配置对应 docker-compose.yml 中的 service 名称
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined, // 如果你设置了密码
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