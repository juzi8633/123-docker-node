import { prisma } from '../src/db.js';
import { strmService } from '../src/services/strm.js';
import { fileURLToPath } from 'url';
import { createLogger } from '../src/logger.js'; // [优化] 引入日志模块

// [优化] 初始化模块专用日志
const logger = createLogger('SyncStrm');

// 封装为主函数，供 API 调用
export async function runSyncStrm() {
    logger.info('🚀 [Start] 开始全量同步 strm 文件...');
    const startTime = Date.now();

    try {
        // 1. 初始化
        logger.info('[Init] 正在初始化 StrmService...');
        await strmService.init();

        // 2. 获取总数
        const total = await prisma.seriesEpisode.count();
        logger.info({ total }, `📊 [Stats] 数据库中共有 ${total} 个媒体文件待处理`);

        if (total === 0) {
            logger.info('[End] 数据库为空，无需同步');
            return { success: true, message: "数据库为空" };
        }

        const BATCH_SIZE = 500;
        let processed = 0;
        let lastId = 0; // [优化] 游标指针
        let batchCount = 0;

        // 使用 while(true) 配合 break，基于 ID 游标遍历
        while (true) {
            batchCount++;
            // logger.debug({ batchCount, lastId, limit: BATCH_SIZE }, `正在获取数据...`);

            // [优化] Cursor-based Pagination
            // 不再使用 skip，而是使用 where id > lastId
            // 性能从 O(N) 提升到 O(1)
            const episodes = await prisma.seriesEpisode.findMany({
                select: { id: true },
                take: BATCH_SIZE,
                where: {
                    id: { gt: lastId }
                },
                orderBy: { id: 'asc' }
            });

            if (episodes.length === 0) {
                logger.info(`[Batch ${batchCount}] 未获取到更多数据，循环结束`);
                break;
            }

            const currentBatchFirst = episodes[0].id;
            const currentBatchLast = episodes[episodes.length - 1].id;
            
            const batchStart = Date.now();

            // 并发执行
            // strmService.syncEpisode 内部已经捕获了异常，所以 Promise.all 不会崩
            await Promise.all(episodes.map(ep => strmService.syncEpisode(ep.id)));

            const batchDuration = Date.now() - batchStart;

            // 更新状态
            processed += episodes.length;
            // [关键] 更新游标为当前批次最后一条的 ID
            lastId = currentBatchLast;
            
            // 打印批次日志 (每批次打印一次，避免刷屏)
            logger.info({ 
                batch: batchCount, 
                count: episodes.length, 
                durationMs: batchDuration, 
                idRange: `${currentBatchFirst}-${currentBatchLast}`,
                progress: `${processed}/${total}`
            }, `[Progress] 批次完成`);

            // 只有在命令行运行时才打印进度条 (视觉效果)
            if (process.argv[1] === fileURLToPath(import.meta.url)) {
                const percent = ((processed / total) * 100).toFixed(1);
                // 使用 stdout.write 实现单行刷新
                process.stdout.write(`\r🔄 正在处理: ${processed}/${total} (${percent}%)`);
            }
        }

        const totalTime = Date.now() - startTime;
        const durationSec = (totalTime / 1000).toFixed(2);
        const speed = (processed / (totalTime / 1000)).toFixed(1);

        // 如果是命令行，换行以避免覆盖进度条
        if (process.argv[1] === fileURLToPath(import.meta.url)) {
            process.stdout.write('\n');
        }

        logger.info({ durationSec, processed, speed }, `🎉 [Done] 同步完成`);
        
        return { 
            success: true, 
            processed, 
            total, 
            duration: durationSec 
        };

    } catch (e) {
        if (process.argv[1] === fileURLToPath(import.meta.url)) console.error('\n'); // 确保错误日志另起一行
        logger.error(e, `❌ [Error] 同步过程发生异常`);
        throw e;
    }
}

// 检查是否直接运行 (CLI 模式)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runSyncStrm()
        .then(() => process.exit(0))
        .catch((e) => {
            // logger.error 已在 catch 中处理，这里只需退出
            process.exit(1);
        });
}