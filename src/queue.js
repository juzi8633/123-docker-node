// src/queue.js

import { Queue, Worker } from 'bullmq';
import { core123 } from './services/core123.js';
import { prisma } from './db.js';
import redis from './redis.js';
import { createHash } from 'crypto';

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379')
};

export const downloadQueue = new Queue('download-queue', { connection: REDIS_CONFIG });

// 189直链解析 (保持不变)
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
  
  // 反查 Row ID
  let rowId = task.id;
  if (!rowId || rowId <= 0) {
      const pendingRecord = await prisma.pendingEpisode.findFirst({ where: { etag: task.etag } });
      if (pendingRecord) rowId = pendingRecord.id;
  }

  console.log(`[Queue] 🔵 收到任务: ${taskName} (ID: ${rowId})`);

  try {
    // ==================================================
    // 🔥 [核心优化] 数据库前置检查 (Pre-Check)
    // ==================================================
    if (task.tmdbId && task.season && task.episode) {
        // 查库：看这个位置有没有文件
        const existing = await prisma.seriesEpisode.findFirst({
            where: {
                tmdbId: task.tmdbId,
                season: task.season,
                episode: task.episode,
                type: dbFileType // 区分视频和字幕
            }
        });

        if (existing) {
            // 情况 1: 完全相同的文件 (Etag 一样) -> 跳过
            if (existing.etag === task.etag) {
                console.log(`[Queue] ⏭️ 跳过重复文件 (Hash相同): ${taskName}`);
                // 清理 Pending 记录
                if (rowId > 0) await prisma.pendingEpisode.delete({ where: { id: rowId } });
                return { status: 'skipped_duplicate' };
            }

            // 情况 2: 库里画质更好或相等 -> 跳过 (不做降级)
            const oldScore = existing.score || 0;
            const newScore = task.score || 0;
            
            if (oldScore >= newScore) {
                console.log(`[Queue] ⏭️ 跳过低分/同分文件 (库内:${oldScore} vs 新:${newScore}): ${taskName}`);
                // 清理 Pending 记录
                if (rowId > 0) await prisma.pendingEpisode.delete({ where: { id: rowId } });
                return { status: 'skipped_low_score' };
            }

            // 情况 3: 新文件分更高 -> 继续执行 (将触发覆盖逻辑)
            console.log(`[Queue] 🆙 发现更高画质 (库内:${oldScore} -> 新:${newScore})，准备升级: ${taskName}`);
        }
    }
    // ==================================================

    const token = await core123.getAccessToken();
    const parentID = await core123.getUploadParentID();

    // A. 尝试秒传
    const createRes = await fetch("https://open-api.123pan.com/upload/v2/file/create", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Platform": "open_platform", "Content-Type": "application/json" },
        body: JSON.stringify({
            parentFileID: parentID,
            filename: taskName,
            etag: task.etag,
            size: Number(task.size),
            duplicate: 2 
        })
    });
    
    const createJson = await createRes.json();
    const canReuse = (createJson.code === 0 && createJson.data?.reuse === true);

    if (canReuse) {
        console.log(`[Queue] ✅ 秒传成功: ${taskName}`);
        
        // 事务：先删旧(为了覆盖) -> 再插入 -> 删Pending
        const now = new Date();
        const ops = [];
        
        // 如果是视频，先清理旧占位 (虽然 Upsert 可以，但为了保险先 Delete)
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
        return { status: 'rapid_success' };
    }

    // B. 秒传失败降级逻辑
    console.log(`[Queue] ⚠️ 秒传失败: ${taskName}`);

    if (task.sourceType === 'quark') {
        // [关键] 夸克不支持离线，直接抛出UnrecoverableError避免重试？
        // BullMQ 默认会重试，如果你想让它直接失败，需要特殊处理
        // 但这里我们抛出错误，让它在 Pending 表里显示重试次数增加，也没问题
        throw new Error("夸克秒传失败 (云端无此文件)，不支持离线下载");
    }

    console.log(`[Queue] 🔄 尝试转离线下载 (${task.sourceType})...`);
    
    let downloadUrl = task.url; 
    if (task.sourceType === '189') {
        downloadUrl = await resolve189Link(task.sourceRef);
    }

    if (!downloadUrl || !downloadUrl.startsWith('http')) {
        throw new Error(`无法获取下载直链，无法离线下载`);
    }

    const callbackKey = process.env.CALLBACK_SECRET;
    const host = process.env.HOST_URL || 'http://localhost:3000'; 
    const callbackUrl = `${host}/api/callback/123?id=${rowId}&key=${callbackKey}`;

    const offlineRes = await fetch("https://open-api.123pan.com/api/v1/offline/download", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Platform": "open_platform", "Content-Type": "application/json" },
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
    return { status: 'downloading', taskId: offlineJson.data.taskID };

  } catch (e) {
    console.error(`[Queue] ❌ 失败: ${e.message}`);
    if (rowId > 0) {
        await prisma.pendingEpisode.update({ where: { id: rowId }, data: { retryCount: { increment: 1 } } });
    }
    throw e; 
  }
}, { 
    connection: REDIS_CONFIG,
    limiter: { max: 1, duration: 3000 } // 保持限流
});

export const addToQueue = async (taskData) => {
  await downloadQueue.add('process', taskData, {
    removeOnComplete: true,
    attempts: taskData.sourceType === 'quark' ? 1 : 3, // 夸克只试1次，其他试3次
    backoff: { type: 'exponential', delay: 5000 }
  });
};