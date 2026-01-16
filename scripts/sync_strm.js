import { prisma } from '../src/db.js';
import { strmService } from '../src/services/strm.js';
import { fileURLToPath } from 'url';

// [新增] 简易日志工具
function log(msg) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    const prefix = `[SyncStrm ${time}]`;
    console.log(`${prefix} ${msg}`);
}

// 封装为主函数，供 API 调用
export async function runSyncStrm() {
    log('🚀 [Start] 开始全量同步 strm 文件...');
    const startTime = Date.now();

    try {
        // 1. 初始化
        log('[Init] 正在初始化 StrmService...');
        await strmService.init();

        // 2. 获取总数
        const total = await prisma.seriesEpisode.count();
        log(`📊 [Stats] 数据库中共有 ${total} 个媒体文件待处理`);

        if (total === 0) {
            log('[End] 数据库为空，无需同步');
            return { success: true, message: "数据库为空" };
        }

        const BATCH_SIZE = 500;
        let processed = 0;
        let lastId = 0; // [优化] 游标指针
        let batchCount = 0;

        // 使用 while(true) 配合 break，基于 ID 游标遍历
        while (true) {
            batchCount++;
            // log(`[Batch ${batchCount}] 正在获取数据 (LastID: ${lastId}, Limit: ${BATCH_SIZE})...`);

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
                log(`[Batch ${batchCount}] 未获取到更多数据，循环结束`);
                break;
            }

            const currentBatchFirst = episodes[0].id;
            const currentBatchLast = episodes[episodes.length - 1].id;
            // log(`[Batch ${batchCount}] 获取到 ${episodes.length} 条 (ID范围: ${currentBatchFirst} - ${currentBatchLast})`);

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
            log(`[Progress] 批次 ${batchCount} 完成 | 本批 ${episodes.length} 条 | 耗时 ${batchDuration}ms | ID进度 ${currentBatchLast} | 总进度 ${processed}/${total}`);

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

        log(`🎉 [Done] 同步完成!`);
        log(`📈 [Report] 总耗时: ${durationSec}s | 处理总数: ${processed} | 平均速度: ${speed} 个/秒`);

        return { 
            success: true, 
            processed, 
            total, 
            duration: durationSec 
        };

    } catch (e) {
        console.error('\n'); // 确保错误日志另起一行
        console.error(`❌ [Error] 同步过程发生异常:`, e);
        log(`❌ [Error] 异常堆栈: ${e.message}`);
        throw e;
    }
}

// 检查是否直接运行 (CLI 模式)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runSyncStrm()
        .then(() => process.exit(0))
        .catch((e) => {
            console.error(e);
            process.exit(1);
        });
}