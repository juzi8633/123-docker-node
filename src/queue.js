import { Queue, Worker } from 'bullmq';
import { core123 } from './services/core123.js';
import { prisma } from './db.js';
import redis from './redis.js';
import { createHash } from 'crypto';
import { strmService } from './services/strm.js'; 

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379')
};

export const downloadQueue = new Queue('download-queue', { connection: REDIS_CONFIG });

// 辅助函数：189直链解析
async function resolve189Link(sourceRef) {
    const token = await redis.get('auth:189:token');
    if (!token) throw new Error("缺少天翼云 AccessToken");
    const parts = sourceRef.split('|');
    const fileId = parts[0];
    const shareId = parts[1];
    const timestamp = Date.now();
    const signStr = `AccessToken=${token}&Timestamp=${timestamp}&dt=1&fileId=${fileId}&shareId=${shareId}`;
    const signature = createHash('md5').update(signStr).digest('hex');
    const url = `https://api.cloud.189.cn/open/file/getFileDownloadUrl.action?fileId=${fileId}&dt=1&shareId=${shareId}`;
    const res = await fetch(url, {
        headers: { 'Sign-Type': '1', 'Accesstoken': token, 'Timestamp': String(timestamp), 'Signature': signature }
    });
    const data = await res.json();
    if (data.res_code === 0) return data.fileDownloadUrl;
    throw new Error(`189 API Error: ${data.res_code} - ${data.res_message}`);
}

// ==========================================
// Worker 消费者
// ==========================================
const worker = new Worker('download-queue', async (job) => {
  const task = job.data;
  const taskName = task.cleanName || task.name; 
  const dbFileType = (task.tier === 'subtitle' || task.type === 'subtitle') ? 'subtitle' : 'video';
  
  // 锁 Key
  const LOCK_KEY = `lock:queue:${task.etag}`;
  const LOCK_TTL = 60; 

  let rowId = task.id;
  if (!rowId || rowId <= 0) {
      const pendingRecord = await prisma.pendingEpisode.findFirst({ where: { etag: task.etag } });
      if (pendingRecord) rowId = pendingRecord.id;
  }

  console.log(`[Queue] 🔵 收到任务: ${taskName} (ID: ${rowId})`);

  try {
    // 1. 获取分布式锁
    const acquired = await redis.set(LOCK_KEY, 'LOCKED', 'NX', 'EX', LOCK_TTL);
    if (!acquired) {
        // console.warn(`[Queue] 🔒 任务锁定中: ${taskName}`);
        throw new Error('Task Locked (Concurrency Protection)');
    }

    // 2. 数据库前置检查
    if (task.tmdbId && task.season && task.episode) {
        const existing = await prisma.seriesEpisode.findFirst({
            where: {
                tmdbId: task.tmdbId,
                season: task.season,
                episode: task.episode,
                type: dbFileType
            }
        });

        if (existing) {
            if (existing.etag === task.etag) {
                console.log(`[Queue] ⏭️ 跳过重复文件: ${taskName}`);
                if (rowId > 0) await prisma.pendingEpisode.delete({ where: { id: rowId } });
                await redis.del(LOCK_KEY);
                return { status: 'skipped_duplicate' };
            }
            const oldScore = existing.score || 0;
            const newScore = task.score || 0;
            if (oldScore >= newScore) {
                console.log(`[Queue] ⏭️ 跳过低分文件: ${taskName}`);
                if (rowId > 0) await prisma.pendingEpisode.delete({ where: { id: rowId } });
                await redis.del(LOCK_KEY);
                return { status: 'skipped_low_score' };
            }
            console.log(`[Queue] 🆙 准备洗版升级: ${taskName}`);
        }
    }

    // ==================================================
    // [修改点] 使用工兵账号进行秒传探测 (Probe)
    // ==================================================
    // 不再调用 getAccessToken，而是直接调用 probeFileByHash
    const canReuse = await core123.probeFileByHash(taskName, task.etag, Number(task.size));

    if (canReuse) {
        console.log(`[Queue] ✅ 秒传成功 (工兵探测确认): ${taskName}`);
        
        const now = new Date();
        const ops = [];
        
        if (dbFileType !== 'subtitle') {
            ops.push(prisma.seriesEpisode.deleteMany({
                where: { tmdbId: task.tmdbId, season: task.season, episode: task.episode, type: { not: 'subtitle' } }
            }));
        }

        ops.push(prisma.seriesEpisode.create({
            data: {
                tmdbId: task.tmdbId, season: task.season, episode: task.episode,
                cleanName: taskName, etag: task.etag, size: BigInt(task.size),
                score: task.score || 0, type: dbFileType, createdAt: now
            }
        }));
        
        ops.push(prisma.seriesMain.update({ where: { tmdbId: task.tmdbId }, data: { lastUpdated: now } }));
        if (rowId > 0) ops.push(prisma.pendingEpisode.delete({ where: { id: rowId } }));

        await prisma.$transaction(ops);

        // 触发 strm 生成
        try {
            const newEp = await prisma.seriesEpisode.findFirst({
                where: { tmdbId: task.tmdbId, season: task.season, episode: task.episode, type: dbFileType },
                orderBy: { id: 'desc' }
            });
            if (newEp) {
                // console.log(`[Queue] 🔄 Strm update ID: ${newEp.id}`);
                await strmService.syncEpisode(newEp.id);
            }
        } catch (strmErr) { console.error(strmErr); }
        
        await redis.del(LOCK_KEY);
        return { status: 'rapid_success' };
    }

    // B. 秒传失败 -> 离线下载 (Fallback)
    console.log(`[Queue] ⚠️ 秒传失败，准备离线下载: ${taskName}`);

    if (task.sourceType === 'quark') throw new Error("夸克不支持离线下载");

    let downloadUrl = task.url; 
    if (task.sourceType === '189') downloadUrl = await resolve189Link(task.sourceRef);
    if (!downloadUrl || !downloadUrl.startsWith('http')) throw new Error(`无法获取下载直链`);

    const callbackKey = process.env.CALLBACK_SECRET;
    const host = process.env.HOST_URL || 'http://localhost:3000'; 
    const callbackUrl = `${host}/api/callback/123?id=${rowId}&key=${callbackKey}`;

    // [修改点] 离线下载必须使用 VIP 账号 Token
    const vipToken = await core123.getVipToken();
    const parentID = await core123.getUploadParentID(); // 获取 VIP 缓存目录

    const offlineRes = await fetch("https://open-api.123pan.com/api/v1/offline/download", {
        method: "POST",
        headers: { "Authorization": `Bearer ${vipToken}`, "Platform": "open_platform", "Content-Type": "application/json" },
        body: JSON.stringify({
            url: downloadUrl, fileName: taskName, dirID: parentID, callBackUrl: callbackUrl
        })
    });

    const offlineJson = await offlineRes.json();
    if (offlineJson.code !== 0) throw new Error(`离线提交失败: ${offlineJson.message}`);

    if (rowId > 0) {
        await prisma.pendingEpisode.update({
            where: { id: rowId },
            data: { taskId: String(offlineJson.data.taskID) }
        });
    }

    console.log(`[Queue] 🚀 离线任务已提交 TaskID: ${offlineJson.data.taskID}`);
    
    await redis.del(LOCK_KEY);
    return { status: 'downloading', taskId: offlineJson.data.taskID };

  } catch (e) {
    if (e.message !== 'Task Locked (Concurrency Protection)') {
        const LOCK_KEY = `lock:queue:${task.etag}`;
        await redis.del(LOCK_KEY).catch(() => {});
        console.error(`[Queue] ❌ 失败: ${e.message}`);
        
        if (rowId > 0) {
            await prisma.pendingEpisode.update({ where: { id: rowId }, data: { retryCount: { increment: 1 } } });
        }
    }
    throw e;
  }
}, { 
    connection: REDIS_CONFIG,
    limiter: { max: 1, duration: 3000 } // 提高并发，因为 probeFileByHash 很快
});

export const addToQueue = async (taskData) => {
  await downloadQueue.add('process', taskData, {
    removeOnComplete: true,
    attempts: taskData.sourceType === 'quark' ? 1 : 5,
    backoff: { type: 'exponential', delay: 2000 }
  });
};