// scripts/sync_strm.js
import { prisma } from '../src/db.js';
import { strmService } from '../src/services/strm.js';
import { fileURLToPath } from 'url';
import { createLogger } from '../src/logger.js'; // [优化] 引入日志模块

// [优化] 初始化模块专用日志
const logger = createLogger('SyncStrm');

// [新增] 延时工具函数
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 封装为主函数，供 API 调用
export async function runSyncStrm() {
    logger.info('🚀 [Start] 开始智能同步 strm 文件 (读写分离模式)...');
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
        let lastId = 0; // 游标指针
        let batchCount = 0;

        // 使用 while(true) 配合 break，基于 ID 游标遍历
        while (true) {
            batchCount++;
            
            // [优化] Cursor-based Pagination
            // 必须 include: { series: true }，因为 calculatePath 需要分类信息
            const episodes = await prisma.seriesEpisode.findMany({
                take: BATCH_SIZE,
                where: {
                    id: { gt: lastId }
                },
                include: { series: true }, 
                orderBy: { id: 'asc' }
            });

            if (episodes.length === 0) {
                logger.info(`[Batch ${batchCount}] 未获取到更多数据，循环结束`);
                break;
            }

            // 更新游标 (取当前批次最后一条的 ID)
            lastId = episodes[episodes.length - 1].id;
            
            // [核心修改] 队列分离
            const videoQueue = episodes.filter(ep => ep.type !== 'subtitle');
            const subQueue = episodes.filter(ep => ep.type === 'subtitle');

            const batchStart = Date.now();

            // 1. 视频处理：极速并发模式 (因为不涉及网络，纯 IO)
            if (videoQueue.length > 0) {
                // logger.debug(`[Batch] 正在极速生成 ${videoQueue.length} 个视频 STRM...`);
                await Promise.all(videoQueue.map(ep => strmService.syncVideo(ep)));
            }

            // 2. 字幕处理：龟速串行模式 (防风控，流控)
            let subSuccess = 0;
            if (subQueue.length > 0) {
                logger.info(`[Batch] 发现 ${subQueue.length} 个字幕，进入慢速下载模式 (2秒/个)...`);
                for (const sub of subQueue) {
                    const ok = await strmService.syncSubtitle(sub);
                    if (ok) subSuccess++;
                    // 无论成功失败，为了防止接口过热，建议都休眠，或者仅成功后休眠
                    // 这里采用强制休眠 2 秒
                    await sleep(2000); 
                }
            }

            const batchDuration = Date.now() - batchStart;
            processed += episodes.length;
            
            // 打印批次日志
            logger.info({ 
                batch: batchCount, 
                videos: videoQueue.length,
                subs: `${subSuccess}/${subQueue.length}`,
                durationMs: batchDuration, 
                progress: `${processed}/${total}`
            }, `[Progress] 批次完成`);

            // CLI 进度条
            if (process.argv[1] === fileURLToPath(import.meta.url)) {
                const percent = ((processed / total) * 100).toFixed(1);
                process.stdout.write(`\r🔄 处理中: ${processed}/${total} (${percent}%) - 上批耗时: ${batchDuration}ms`);
            }
        }

        // [新增] 循环结束后，统一触发一次 Emby 扫描
        await strmService.triggerScan();

        const totalTime = Date.now() - startTime;
        const durationSec = (totalTime / 1000).toFixed(2);
        
        if (process.argv[1] === fileURLToPath(import.meta.url)) {
            process.stdout.write('\n');
        }

        logger.info({ durationSec, processed }, `🎉 [Done] 同步完成`);
        
        return { 
            success: true, 
            processed, 
            total, 
            duration: durationSec 
        };

    } catch (e) {
        if (process.argv[1] === fileURLToPath(import.meta.url)) console.error('\n');
        logger.error(e, `❌ [Error] 同步过程发生异常`);
        throw e;
    }
}

// 检查是否直接运行 (CLI 模式)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runSyncStrm()
        .then(() => process.exit(0))
        .catch((e) => {
            process.exit(1);
        });
}