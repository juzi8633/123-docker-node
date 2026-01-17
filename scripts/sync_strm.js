// scripts/sync_strm.js
import { prisma } from '../src/db.js';
import { strmService } from '../src/services/strm.js';
import { fileURLToPath } from 'url';
import { createLogger } from '../src/logger.js'; 

const logger = createLogger('SyncStrm');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// [修改] 增加 options 参数
export async function runSyncStrm(options = { 
    overwriteStrm: false, 
    overwriteSub: false, 
    skipSub: false 
}) {
    logger.info(`🚀 [Start] 开始同步. 策略: 覆盖STRM=${options.overwriteStrm}, 覆盖字幕=${options.overwriteSub}, 跳过字幕=${options.skipSub}`);
    const startTime = Date.now();

    try {
        await strmService.init();
        const total = await prisma.seriesEpisode.count();
        if (total === 0) return { success: true, message: "数据库为空" };

        const BATCH_SIZE = 500;
        let processed = 0;
        let lastId = 0; 
        let batchCount = 0;

        while (true) {
            batchCount++;
            const episodes = await prisma.seriesEpisode.findMany({
                take: BATCH_SIZE,
                where: { id: { gt: lastId } },
                include: { series: true }, 
                orderBy: { id: 'asc' }
            });

            if (episodes.length === 0) break;

            lastId = episodes[episodes.length - 1].id;
            const videoQueue = episodes.filter(ep => ep.type !== 'subtitle');
            const subQueue = episodes.filter(ep => ep.type === 'subtitle');

            const batchStart = Date.now();

            // 1. 视频处理
            if (videoQueue.length > 0) {
                await Promise.all(videoQueue.map(ep => 
                    strmService.syncVideo(ep, { overwrite: options.overwriteStrm })
                ));
            }

            // 2. 字幕处理
            let subSuccess = 0;
            if (!options.skipSub && subQueue.length > 0) {
                for (const sub of subQueue) {
                    const ok = await strmService.syncSubtitle(sub, { overwrite: options.overwriteSub });
                    if (ok) {
                        subSuccess++;
                        // 如果开启了覆盖模式或者原本不存在，则需要限流
                        // 简单的逻辑判断：如果是下载成功的，则执行休眠
                        await sleep(2000); 
                    }
                }
            }

            const batchDuration = Date.now() - batchStart;
            processed += episodes.length;
            
            logger.info({ 
                batch: batchCount, 
                videos: videoQueue.length,
                subs: options.skipSub ? 'skipped' : `${subSuccess}/${subQueue.length}`,
                progress: `${processed}/${total}`
            }, `[Progress] 批次完成`);

            if (process.argv[1] === fileURLToPath(import.meta.url)) {
                const percent = ((processed / total) * 100).toFixed(1);
                process.stdout.write(`\r🔄 处理中: ${processed}/${total} (${percent}%)`);
            }
        }

        await strmService.triggerScan();
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info({ durationSec, processed }, `🎉 [Done] 同步完成`);
        
        return { success: true, processed, total, duration: durationSec };

    } catch (e) {
        logger.error(e, `❌ [Error] 同步过程发生异常`);
        throw e;
    }
}

// CLI 运行时增加环境变量解析支持
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const config = {
        overwriteStrm: process.env.OVERWRITE_STRM === 'true',
        overwriteSub: process.env.OVERWRITE_SUB === 'true',
        skipSub: process.env.SKIP_SUB === 'true'
    };
    runSyncStrm(config).then(() => process.exit(0)).catch(() => process.exit(1));
}