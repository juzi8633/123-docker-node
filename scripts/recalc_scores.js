// scripts/recalc_scores.js
import { prisma } from '../src/db.js';
import { analyzeName, calculateScore } from '../src/utils.js';

// [新增] 简易日志工具
function log(msg) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    const prefix = `[RecalcScore ${time}]`;
    console.log(`${prefix} ${msg}`);
}

async function main() {
    log("🔄 [Start] 开始重算数据库评分...");
    
    // 1. 获取所有视频文件 (排除字幕)
    log("正在从数据库加载所有视频文件...");
    const episodes = await prisma.seriesEpisode.findMany({
        where: { type: { not: 'subtitle' } }
    });

    log(`📊 共找到 ${episodes.length} 个文件`);
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
            // log(`[Update] ID:${ep.id} 分数变更: ${ep.score} -> ${newScore}`); // 可选详细日志
            await prisma.seriesEpisode.update({
                where: { id: ep.id },
                data: { score: newScore }
            });
            updatedCount++;
            
            if (newScore === 0) {
                zeroedCount++;
                log(`📉 降级为0分: [${(Number(ep.size)/1024/1024/1024).toFixed(1)}GB] ${ep.cleanName}`);
            }
        }

        // [新增] 进度日志 (每1000条打印一次)
        if (processed % 1000 === 0) {
            log(`[Progress] 已处理 ${processed}/${episodes.length} ...`);
        }
    }

    log("-".repeat(30));
    log(`✅ 完成! 共扫描 ${episodes.length} 个文件`);
    log(`📝 更新了 ${updatedCount} 个文件的评分`);
    log(`🗑️ 其中 ${zeroedCount} 个文件因超大或DV被标记为 0 分 (将被后续优选覆盖)`);
    
    await prisma.$disconnect();
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});