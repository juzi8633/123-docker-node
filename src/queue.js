// src/queue.js
import { Queue, Worker } from 'bullmq';
import { core123 } from './services/core123.js';
import { prisma } from './db.js';
import redis, { REDIS_CONNECTION_CONFIG } from './redis.js';
import { createHash } from 'crypto';
import { createLogger } from './logger.js';
import { invalidateCacheByTmdbId } from './webdav.js';

const logger = createLogger('Queue');

export const downloadQueue = new Queue('download-queue', { connection: REDIS_CONNECTION_CONFIG });

// 辅助函数：189直链解析
async function resolve189Link(sourceRef) {
    logger.info({ sourceRef }, `[189Resolver] Resolving link`);
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
        headers: { 
            'Sign-Type': '1', 'Accesstoken': token, 'Timestamp': String(timestamp), 'Signature': signature,
            'Referer': 'https://h5.cloud.189.cn/', 'Accept': 'application/json;charset=UTF-8',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36'
        }
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(`189 API Error: Invalid JSON response`); }
    if (data.res_code === 0) return data.fileDownloadUrl;
    throw new Error(`189 API Error: ${data.res_code} - ${data.res_message}`);
}

const worker = new Worker('download-queue', async (job) => {
  const task = job.data;
  const taskName = task.cleanName || task.name; 
  const dbFileType = (task.tier === 'subtitle' || task.type === 'subtitle') ? 'subtitle' : 'video';
  const LOCK_KEY = `lock:queue:${task.etag}`;
  const LOCK_TTL = 60; 

  let rowId = task.id;
  if (!rowId || rowId <= 0) {
      const pendingRecord = await prisma.pendingEpisode.findFirst({ where: { etag: task.etag } });
      if (pendingRecord) rowId = pendingRecord.id;
  }

  logger.info({ rowId, etag: task.etag }, `🔵 收到任务: ${taskName}`);

  try {
    const acquired = await redis.set(LOCK_KEY, 'LOCKED', 'NX', 'EX', LOCK_TTL);
    if (!acquired) {
        logger.info({ taskName }, `🔒 任务锁定中，跳过`);
        throw new Error('Task Locked (Concurrency Protection)');
    }
    
    // 1. 数据库去重检查
    if (task.tmdbId && task.season && task.episode) {
        const existing = await prisma.seriesEpisode.findFirst({
            where: { tmdbId: task.tmdbId, season: task.season, episode: task.episode, type: dbFileType }
        });
        if (existing) {
            if (existing.etag === task.etag) {
                logger.info({ taskName }, `⏭️ 跳过重复文件`);
                if (rowId > 0) await prisma.pendingEpisode.delete({ where: { id: rowId } });
                await redis.del(LOCK_KEY);
                return { status: 'skipped_duplicate' };
            }
            if ((existing.score || 0) >= (task.score || 0)) {
                logger.info({ taskName }, `⏭️ 跳过低分文件`);
                if (rowId > 0) await prisma.pendingEpisode.delete({ where: { id: rowId } });
                await redis.del(LOCK_KEY);
                return { status: 'skipped_low_score' };
            }
        }
    }

    // 2. 秒传探测
    logger.debug(`[Probe] Checking rapid upload...`);
    const probeResult = await core123.probeFileByHash(taskName, task.etag, Number(task.size));
    const canReuse = (probeResult === true) || (typeof probeResult === 'object' && probeResult.reuse === true);

    if (canReuse) {
        let finalEtag = task.etag;
        let S3KeyFlag = '';
        if (typeof probeResult === 'object') {
            if (probeResult.correctEtag) finalEtag = probeResult.correctEtag;
            if (probeResult.S3KeyFlag) S3KeyFlag = probeResult.S3KeyFlag;
        }

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
                cleanName: taskName, etag: finalEtag, S3KeyFlag,
                size: BigInt(task.size), score: task.score || 0, type: dbFileType, createdAt: now
            }
        }));
        ops.push(prisma.seriesMain.update({ where: { tmdbId: task.tmdbId }, data: { lastUpdated: now } }));
        if (rowId > 0) ops.push(prisma.pendingEpisode.delete({ where: { id: rowId } }));

        await prisma.$transaction(ops);
        logger.info({ taskName }, `✅ 秒传成功`);
        
        try { if (task.tmdbId) await invalidateCacheByTmdbId(task.tmdbId); } catch (e) {}
        await redis.del(LOCK_KEY);
        return { status: 'rapid_success' };
    }

    // 3. 离线下载 (使用 core123 封装)
    if (task.sourceType === 'quark' || task.sourceType === '115') throw new Error("夸克和115不支持离线下载");

    let downloadUrl = task.url; 
    if (task.sourceType === '189') {
        logger.info(`[Offline] Resolving 189 link...`);
        downloadUrl = await resolve189Link(task.sourceRef);
    }
    
    if (!downloadUrl || !downloadUrl.startsWith('http')) throw new Error(`无法获取下载直链`);

    const callbackKey = process.env.SECRET;
    const host = process.env.HOST_URL || 'http://localhost:3000'; 
    const callbackUrl = `${host}/api/callback/123?id=${rowId}&key=${callbackKey}`;

    logger.info({ callbackUrl }, `[Offline] 提交离线任务`);
    
    // [修复] 调用 Core123Service 的封装方法
    const offlineData = await core123.addOfflineTask(downloadUrl, taskName, callbackUrl);

    if (rowId > 0) {
        await prisma.pendingEpisode.update({
            where: { id: rowId },
            data: { taskId: String(offlineData.taskID) }
        });
    }

    try { if (task.tmdbId) await invalidateCacheByTmdbId(task.tmdbId); } catch (e) {}
    
    logger.info({ taskId: offlineData.taskID }, `🚀 离线任务已提交`);
    await redis.del(LOCK_KEY);
    return { status: 'downloading', taskId: offlineData.taskID };

  } catch (e) {
    if (e.message !== 'Task Locked (Concurrency Protection)') {
        await redis.del(LOCK_KEY).catch(() => {});
        logger.error(e, `[Queue] ❌ 任务失败`);
        if (rowId > 0) {
            await prisma.pendingEpisode.update({ where: { id: rowId }, data: { retryCount: { increment: 1 } } });
        }
    }
    throw e;
  }
}, { 
    connection: REDIS_CONNECTION_CONFIG, concurrency: 1, limiter: { max: 1, duration: 3000 }
});

export const addToQueue = async (taskData) => {
  logger.info({ cleanName: taskData.cleanName, type: taskData.sourceType }, `[Producer] Adding to queue`);
  await downloadQueue.add('process', taskData, {
    removeOnComplete: true, attempts: 1, backoff: { type: 'exponential', delay: 2000 }
  });
};
