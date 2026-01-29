import pino from 'pino';
import dotenv from 'dotenv';
dotenv.config();

// =========================================================================
// [优化] 4. 日志系统：基于 Pino 的高性能异步日志
// =========================================================================

// 检查是否在开发环境（开发环境可能需要更可读的格式，生产环境追求极致性能的 JSON）
const isDev = process.env.NODE_ENV !== 'production';

// 创建 Pino 实例
export const logger = pino({
    // 日志级别：生产环境建议 info 或 warn，开发环境 debug
    level: process.env.LOG_LEVEL || 'info',

    // [核心优化] 异步模式 (Asynchronous Logging)
    // 默认情况下 pino 输出到 stdout 是异步的（在 Node v14+），
    // 但为了确保极致性能，我们显式配置。
    // 注意：如果是 Serverless 环境，可能需要设为 sync: true 以防日志丢失，
    // 但在 VPS/Docker 守护进程模式下，异步是最佳选择。
    
    // 时间戳格式化：sys:standard (例如 "time": 1678888888888) 或 ISO
    // 为了方便阅读，这里使用 ISO 格式
    timestamp: pino.stdTimeFunctions.isoTime,

    // 基础字段：不打印 pid 和 hostname 以减少日志体积
    base: undefined,

    // [兼容性] 格式化器
    formatters: {
        level: (label) => {
            return { level: label.toUpperCase() };
        },
    },

    // 如果你有安装 pino-pretty (npm i pino-pretty -D)，可以在开发环境启用它
    // 生产环境建议保持 JSON 格式或使用基本的 stdout，以获得最高 FPS
    transport: isDev ? {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
            messageFormat: '{msg}' 
        }
    } : undefined
});

/**
 * 辅助函数：创建带有模块前缀的子日志记录器
 * 使用示例： const log = createLogger('Service123'); log.info('test');
 * 输出效果： {"level":"INFO","time":"...","module":"Service123","msg":"test"}
 */
export function createLogger(moduleName) {
    return logger.child({ module: moduleName });
}