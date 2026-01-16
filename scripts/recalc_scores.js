// scripts/recalc_scores.js
import { prisma } from '../src/db.js';
import { analyzeName, calculateScore } from '../src/utils.js';
import { createLogger } from '../src/logger.js'; // [优化] 引入日志模块

// [优化] 初始化模块专用日志
const logger = createLogger('RecalcScore');

async function main() {
    logger.info("🔄 [Start] 开始重算数据库评分...");
    
    // 1. 获取所有视频文件 (排除字幕)
    logger.info("正在从数据库加载所有视频文件...");
    const episodes = await prisma.seriesEpisode.findMany({
        where: { type: { not: 'subtitle' } }
    });

    logger.info({ count: episodes.length }, `📊 共找到 ${episodes.length} 个文件`);
    let updatedCount = 0;
    let zeroedCount = 0;
    let processed = 0; // [新增] 用于进度追踪

    for (const ep of episodes) {
        processed++;
        // 重新分析文件名
        const analysis = analyzeName(ep.cleanName);
        const isMovie = !ep.season && !ep.episode; // 简单判断，或者查 series.type
        
        // 计算新分数 (此时 >30GB 或 DV 会返回 0)
        const newScore = calculateScore(analysis, ep.size, isMovie);

        // 如果分数变了，更新数据库
        if (newScore !== ep.score) {
            // logger.debug({ id: ep.id, old: ep.score, new: newScore }, `[Update] 分数变更`); // 可选详细日志
            await prisma.seriesEpisode.update({
                where: { id: ep.id },
                data: { score: newScore }
            });
            updatedCount++;
            
            if (newScore === 0) {
                zeroedCount++;
                const sizeGB = (Number(ep.size)/1024/1024/1024).toFixed(1);
                logger.info({ sizeGB, name: ep.cleanName }, `📉 降级为0分`);
            }
        }

        // [新增] 进度日志 (每1000条打印一次)
        if (processed % 1000 === 0) {
            logger.info({ processed, total: episodes.length }, `[Progress] 处理进度`);
        }
    }

    logger.info({ updatedCount, zeroedCount, total: episodes.length }, `✅ 完成!`);
    
    await prisma.$disconnect();
}

main().catch(e => {
    logger.error(e, '脚本执行异常');
    process.exit(1);
});