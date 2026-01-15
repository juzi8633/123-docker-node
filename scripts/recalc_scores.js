// scripts/recalc_scores.js
import { prisma } from '../src/db.js';
import { analyzeName, calculateScore } from '../src/utils.js';

async function main() {
    console.log("🔄 开始重算数据库评分...");
    
    // 1. 获取所有视频文件 (排除字幕)
    const episodes = await prisma.seriesEpisode.findMany({
        where: { type: { not: 'subtitle' } }
    });

    console.log(`📊 共找到 ${episodes.length} 个文件`);
    let updatedCount = 0;
    let zeroedCount = 0;

    for (const ep of episodes) {
        // 重新分析文件名
        const analysis = analyzeName(ep.cleanName);
        const isMovie = !ep.season && !ep.episode; // 简单判断，或者查 series.type
        
        // 计算新分数 (此时 >30GB 或 DV 会返回 0)
        const newScore = calculateScore(analysis, ep.size, isMovie);

        // 如果分数变了，更新数据库
        if (newScore !== ep.score) {
            await prisma.seriesEpisode.update({
                where: { id: ep.id },
                data: { score: newScore }
            });
            updatedCount++;
            
            if (newScore === 0) {
                zeroedCount++;
                console.log(`📉 降级为0分: [${(Number(ep.size)/1024/1024/1024).toFixed(1)}GB] ${ep.cleanName}`);
            }
        }
    }

    console.log("-".repeat(30));
    console.log(`✅ 完成! 更新了 ${updatedCount} 个文件`);
    console.log(`🗑️ 其中 ${zeroedCount} 个文件因超大或DV被标记为 0 分 (将被后续优选覆盖)`);
    
    await prisma.$disconnect();
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});