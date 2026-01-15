import { prisma } from '../src/db.js';
import { strmService } from '../src/services/strm.js';
import { fileURLToPath } from 'url';

// 封装为主函数，供 API 调用
export async function runSyncStrm() {
    console.log('🚀 [Sync] 开始全量同步 strm 文件...');
    const startTime = Date.now();

    // 1. 初始化
    await strmService.init();

    // 2. 获取总数
    const total = await prisma.seriesEpisode.count();
    console.log(`📊 数据库中共有 ${total} 个媒体文件待处理`);

    if (total === 0) return { success: true, message: "数据库为空" };

    const BATCH_SIZE = 500;
    let processed = 0;
    let lastId = 0; // [优化] 游标指针

    // 使用 while(true) 配合 break，基于 ID 游标遍历
    while (true) {
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

        if (episodes.length === 0) break;

        // 并发执行
        await Promise.all(episodes.map(ep => strmService.syncEpisode(ep.id)));

        // 更新状态
        processed += episodes.length;
        // [关键] 更新游标为当前批次最后一条的 ID
        lastId = episodes[episodes.length - 1].id;
        
        // 只有在命令行运行时才打印进度条，防止 API日志爆炸
        if (process.argv[1] === fileURLToPath(import.meta.url)) {
            const percent = ((processed / total) * 100).toFixed(1);
            process.stdout.write(`\r🔄 正在处理: ${processed}/${total} (${percent}%)`);
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ 全量同步完成，耗时 ${duration}s`);
    return { success: true, processed, duration };
}

// 判断是否直接通过 node 运行 (CLI 模式)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runSyncStrm()
        .then(() => process.exit(0))
        .catch(async (e) => {
            console.error('\n❌ 同步失败:', e);
            await prisma.$disconnect();
            process.exit(1);
        });
}