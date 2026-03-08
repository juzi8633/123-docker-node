// src/queue.js
import { Queue, Worker } from 'bullmq';
import { core123 } from './services/core123.js';
import { prisma } from './db.js';
import redis, { REDIS_CONNECTION_CONFIG } from './redis.js';
import { createLogger } from './logger.js';

const logger = createLogger('Queue');

export const downloadQueue = new Queue('download-queue', { connection: REDIS_CONNECTION_CONFIG });

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
        logger.info({ taskName }, `✅ 秒传成功`)
        await redis.del(LOCK_KEY);
        return { status: 'rapid_success' };
    }

    // 3. 不再走离线下载：探测失败后保留任务，等待人工处理或后续重试
    if (rowId > 0) {
        await prisma.pendingEpisode.update({
            where: { id: rowId },
            data: { taskId: null, retryCount: { increment: 1 } }
        });
    }

    logger.info({ taskName, sourceType: task.sourceType }, `⚠️ 探测未命中，已保留为待人工处理任务`);
    await redis.del(LOCK_KEY);
    return { status: 'probe_failed_manual_review' };

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
