// src/queue.js
import { Queue, Worker } from 'bullmq';
import { core123 } from './services/core123.js';
import { prisma } from './db.js';
import redis from './redis.js';
import { createHash } from 'crypto';
import { createLogger } from './logger.js';

// 初始化专用 Logger
const logger = createLogger('Queue');

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379')
};

export const downloadQueue = new Queue('download-queue', { connection: REDIS_CONFIG });

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
    logger.debug(`[189Resolver] Requesting URL: ${url} (Sign: ${signature})`);

    const res = await fetch(url, {
        headers: { 
            'Sign-Type': '1', 
            'Accesstoken': token, 
            'Timestamp': String(timestamp), 
            'Signature': signature,
            'Referer': 'https://h5.cloud.189.cn/',
            'Accept': 'application/json;charset=UTF-8',
            'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36'
        }
    });
// 1. 读取一次为文本
    const text = await res.text();
    
    let data;
    try {
        // 2. 解析文本为 JSON
        data = JSON.parse(text);
    } catch (e) {
        // 解析失败说明返回的不是 JSON (通常是报错 XML)
        logger.error({ responseText: text }, `[189Resolver] 服务端返回了非 JSON 数据`);
        throw new Error(`189 API Error: Invalid JSON response`);
    }
    
    logger.debug({ data }, `[189Resolver] API Response`);

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

  logger.info({ rowId, etag: task.etag }, `🔵 收到任务: ${taskName}`);

  try {
    // 1. 获取分布式锁
    const acquired = await redis.set(LOCK_KEY, 'LOCKED', 'NX', 'EX', LOCK_TTL);
    if (!acquired) {
        logger.info({ taskName }, `🔒 任务锁定中，跳过 (Concurrency Protection)`);
        throw new Error('Task Locked (Concurrency Protection)');
    }
    
    // 2. 数据库前置检查
    if (task.tmdbId && task.season && task.episode) {
        logger.debug(`[Check] Checking DB for TMDB:${task.tmdbId} S${task.season}E${task.episode} (${dbFileType})`);
        const existing = await prisma.seriesEpisode.findFirst({
            where: {
                tmdbId: task.tmdbId,
                season: task.season,
                episode: task.episode,
                type: dbFileType
            }
        });

        if (existing) {
            logger.info({ id: existing.id, etag: existing.etag, score: existing.score }, `[Check] Found existing record`);
            
            if (existing.etag === task.etag) {
                logger.info({ taskName }, `⏭️ 跳过重复文件 (Etag match)`);
                if (rowId > 0) await prisma.pendingEpisode.delete({ where: { id: rowId } });
                await redis.del(LOCK_KEY);
                return { status: 'skipped_duplicate' };
            }
            const oldScore = existing.score || 0;
            const newScore = task.score || 0;
            
            if (oldScore >= newScore) {
                logger.info({ taskName, oldScore, newScore }, `⏭️ 跳过低分/同分文件`);
                if (rowId > 0) await prisma.pendingEpisode.delete({ where: { id: rowId } });
                await redis.del(LOCK_KEY);
                return { status: 'skipped_low_score' };
            }
            logger.info({ taskName }, `🆙 分数更高，准备洗版升级`);
        }
    }

    // ==================================================
    // [使用工兵账号进行秒传探测]
    // ==================================================
    logger.debug(`[Probe] Calling core123.probeFileByHash...`);
    
    // [修改点 1] 接收返回值（可能是 boolean，也可能是包含 correctEtag 的对象）
    const probeResult = await core123.probeFileByHash(taskName, task.etag, Number(task.size));
    
    // 判断是否成功：true 或 对象中 reuse 为 true
    const canReuse = (probeResult === true) || (typeof probeResult === 'object' && probeResult.reuse === true);
    
    logger.info({ canReuse, result: typeof probeResult === 'object' ? 'Object' : probeResult }, `[Probe] Result`);

    if (canReuse) {
        // [修改点 2] 确定最终入库的 ETag
        // 如果是 SHA1 洗白成功，使用洗白后的 MD5 (correctEtag)
        // 否则使用原始的 MD5 (task.etag)
        let finalEtag = task.etag;
        if (typeof probeResult === 'object' && probeResult.correctEtag) {
            finalEtag = probeResult.correctEtag;
            logger.info(`[Queue] ⚠️ 原始SHA1已洗白为MD5: ${finalEtag}`);
        }

        logger.info({ taskName, finalEtag }, `✅ 秒传成功 (工兵探测确认)`);
        
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
                cleanName: taskName, 
                etag: finalEtag, 
                size: BigInt(task.size),
                score: task.score || 0, type: dbFileType, createdAt: now
            }
        }));
        
        ops.push(prisma.seriesMain.update({ where: { tmdbId: task.tmdbId }, data: { lastUpdated: now } }));
        if (rowId > 0) ops.push(prisma.pendingEpisode.delete({ where: { id: rowId } }));

        await prisma.$transaction(ops);
        logger.info(`[DB] Transaction committed`);
        
        await redis.del(LOCK_KEY);
        return { status: 'rapid_success' };
    }

    // B. 秒传失败 -> 离线下载 (Fallback)
    logger.warn({ taskName }, `⚠️ 秒传失败，准备离线下载`);

    if (task.sourceType === 'quark' || task.sourceType === '115') {
        throw new Error("夸克和115不支持离线下载");
    }

    let downloadUrl = task.url; 
    if (task.sourceType === '189') {
        logger.info(`[Offline] Resolving 189 link...`);
        downloadUrl = await resolve189Link(task.sourceRef);
    }
    
    if (!downloadUrl || !downloadUrl.startsWith('http')) {
        throw new Error(`无法获取下载直链`);
    }

    const callbackKey = process.env.SECRET;
    const host = process.env.HOST_URL || 'http://localhost:3000'; 
    const callbackUrl = `${host}/api/callback/123?id=${rowId}&key=${callbackKey}`;

    const vipToken = await core123.getVipToken();
    const parentID = await core123.getUploadParentID();
    logger.info({ parentID, callbackUrl }, `[Offline] Submitting to 123 API`);

    const offlineRes = await fetch("https://open-api.123pan.com/api/v1/offline/download", {
        method: "POST",
        headers: { "Authorization": `Bearer ${vipToken}`, "Platform": "open_platform", "Content-Type": "application/json" },
        body: JSON.stringify({
            url: downloadUrl, fileName: taskName, dirID: parentID, callBackUrl: callbackUrl
        })
    });

    const offlineJson = await offlineRes.json();
    logger.info({ response: offlineJson }, `[Offline] 123 API Response`);

    if (offlineJson.code !== 0) throw new Error(`离线提交失败: ${offlineJson.message}`);

    if (rowId > 0) {
        await prisma.pendingEpisode.update({
            where: { id: rowId },
            data: { taskId: String(offlineJson.data.taskID) }
        });
        logger.info({ taskId: offlineJson.data.taskID }, `[DB] Updated pending record`);
    }

    logger.info({ taskId: offlineJson.data.taskID }, `🚀 离线任务已提交`);
    
    await redis.del(LOCK_KEY);
    return { status: 'downloading', taskId: offlineJson.data.taskID };

  } catch (e) {
    if (e.message !== 'Task Locked (Concurrency Protection)') {
        const LOCK_KEY = `lock:queue:${task.etag}`;
        await redis.del(LOCK_KEY).catch(() => {});
        logger.error(e, `[Queue] ❌ 任务失败`);
        
        if (rowId > 0) {
            await prisma.pendingEpisode.update({ where: { id: rowId }, data: { retryCount: { increment: 1 } } });
            logger.info(`[DB] Incremented retry count for ID: ${rowId}`);
        }
    }
    throw e;
  }
}, { 
    connection: REDIS_CONFIG,
    concurrency: 1, 
    limiter: { max: 1, duration: 3000 }
});

export const addToQueue = async (taskData) => {
  logger.info({ cleanName: taskData.cleanName, type: taskData.sourceType }, `[Producer] Adding to queue`);
  await downloadQueue.add('process', taskData, {
    removeOnComplete: true,
    attempts: 1,
    backoff: { type: 'exponential', delay: 2000 }
  });
};