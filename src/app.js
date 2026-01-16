import Fastify from 'fastify';
import dotenv from 'dotenv';
import { Readable } from 'stream';
import path from 'path'; 
import { fileURLToPath } from 'url'; 
import fastifyStatic from '@fastify/static'; 

// 引入核心模块
import { addToQueue } from './queue.js';
import { prisma } from './db.js'; 
import redis from './redis.js';
import { core123 } from './services/core123.js';
import { strmService } from './services/strm.js'; 
import { createLogger } from './logger.js'; // [优化] 引入日志模块

// 引入管理脚本逻辑
import { runSyncStrm } from '../scripts/sync_strm.js';
import { runVerifyStrm } from '../scripts/verify_strm.js';

import { create123RapidTransfer } from "./services/service123.js";
import { create189RapidTransfer } from "./services/service189.js";
import { createQuarkRapidTransfer } from "./services/serviceQuark.js";

import { 
    analyzeName, 
    calculateScore, 
    RE_TMDB_TAG, 
    RE_SEASON_EPISODE, 
    RE_FILE_EXT, 
    RE_CLEAN_NAME, 
    RE_SPACE, 
    detectSubtitleLanguage, 
    safeParseYear
} from './utils.js';

BigInt.prototype.toJSON = function () { return this.toString(); };

dotenv.config();

// [优化] 初始化高性能日志
const logger = createLogger('App');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ 
    logger: true, // Fastify 默认日志也开启，用于记录 HTTP 请求详情
    bodyLimit: 50 * 1024 * 1024
});

app.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/', 
    wildcard: false 
});

const CALLBACK_SECRET = process.env.CALLBACK_SECRET;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;

const metaCache = new Map();
let isMaintenanceRunning = false;

app.addHook('onReady', async () => {
    try {
        logger.info('正在检查 Redis 连接...');
        await redis.ping();
        
        logger.info('正在检查数据库连接...');
        await prisma.$queryRaw`SELECT 1`; 
        
        if (core123.reloadConfig) {
            logger.info('触发 Core123 配置预加载...');
            await core123.reloadConfig();
            app.log.info('✅ [System] Core123 配置已加载');
        }

        await core123.initLinkCacheFolder();
        await strmService.init();

        app.log.info('✅ [System] Redis & SQLite 连接成功');
        logger.info('系统启动完成');
    } catch (err) {
        app.log.error(err, '❌ [System] 启动失败');
        process.exit(1);
    }
});

app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url;
    if (url.startsWith('/api/') || url === '/' || url === '/index.html' || url.includes('/assets/') || url === '/favicon.ico') return;
    if (AUTH_PASSWORD && url.startsWith('/api') && req.headers['authorization'] !== AUTH_PASSWORD) {}
});

app.get('/api/health', async (req, reply) => {
    return { status: 'running', service: '123-Node-Server (Strm Mode)' };
});

// ==========================================
// [新增] 核心修改：无状态播放接口
// ==========================================
// URL 格式: /api/play/stream?hash=xxx&size=123&name=video.mp4
app.get('/api/play/stream', async (req, reply) => {
    const { hash, size, name } = req.query;

    if (!hash || !size || !name) {
        logger.warn(`[Play] ❌ 参数缺失: Hash/Size/Name 必须提供`);
        return reply.code(400).send("Missing hash, size or name params");
    }

    logger.info({ hash, size, name }, `[Play] 收到无状态播放请求: ${name}`);

    try {
        // 直接调用 core123，不查数据库
        // 这意味着只要有 hash，哪怕数据库记录删了，也能播放
        const downloadUrl = await core123.getDownloadUrlByHash(
            name, 
            hash, 
            Number(size)
        );

        if (!downloadUrl) throw new Error("Link generation failed");
        
        logger.info(`[Play] ✅ 获取直链成功 (无状态模式)，执行 302 跳转`);
        return reply.redirect(302, downloadUrl);
    } catch (e) {
        logger.error(e, `[Play] ❌ 获取直链失败`);
        return reply.code(502).send("Upstream Error");
    }
});

// [保留] 旧的 ID 播放接口 (为了兼容现有未更新的 strm 文件)
app.get('/api/play/:id', async (req, reply) => {
    const { id } = req.params;
    // 防止 stream 被误识别为 id
    if (id === 'stream') return; 

    logger.info({ id }, `[Play] 收到 ID 播放请求`);
    
    const file = await prisma.seriesEpisode.findUnique({
        where: { id: parseInt(id) },
        select: { cleanName: true, etag: true, size: true }
    });
    
    if (!file) {
        logger.warn({ id }, `[Play] ❌ 数据库中未找到文件`);
        return reply.code(404).send("File not found in DB");
    }

    try {
        const downloadUrl = await core123.getDownloadUrlByHash(file.cleanName, file.etag, Number(file.size));
        if (!downloadUrl) throw new Error("Link generation failed");
        logger.info(`[Play] ✅ 获取直链成功 (ID模式)，执行 302 跳转`);
        reply.header('CDN-Cache-Control', 'public, max-age=432000'); 
        reply.header('Cache-Control', 'public, max-age=3600');
        return reply.redirect(302, downloadUrl);
    } catch (e) {
        logger.error(e, `[Play] ❌ ID模式失败`);
        return reply.code(502).send("Upstream Error");
    }
});

app.get('/api/search', async (req, reply) => {
    const { q, page = 1, size = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(size);
    const take = parseInt(size);
    const where = q ? { OR: [ { name: { contains: q } }, ...( !isNaN(q) ? [{ tmdbId: parseInt(q) }] : []) ] } : {};
    try {
        const [total, list] = await prisma.$transaction([
            prisma.seriesMain.count({ where: { ...where, episodes: { some: {} } } }),
            prisma.seriesMain.findMany({
                where: { ...where, episodes: { some: {} } },
                take, skip, orderBy: { lastUpdated: 'desc' },
                select: { tmdbId: true, name: true, year: true, type: true, genres: true, originalLanguage: true, originCountry: true, lastUpdated: true }
            })
        ]);
        return { total, list, page: parseInt(page), size: take };
    } catch (e) { return reply.code(500).send({ error: e.message }); }
});

app.get('/api/details', async (req, reply) => {
    const id = parseInt(req.query.id);
    if (!id || isNaN(id)) return { error: "No ID provided" };
    try {
        const seriesInfo = await prisma.seriesMain.findUnique({ where: { tmdbId: id } });
        if (!seriesInfo) return { error: "Series not found" };
        const episodes = await prisma.seriesEpisode.findMany({
            where: { tmdbId: id },
            orderBy: [{ season: 'asc' }, { episode: 'asc' }, { type: 'desc' }]
        });
        return { info: seriesInfo, episodes };
    } catch (e) { return reply.code(500).send({ error: e.message }); }
});

app.get('/api/pending/list', async (req, reply) => {
    const { page = 1, size = 20, filter = 'pending' } = req.query;
    const take = parseInt(size);
    const skip = (parseInt(page) - 1) * take;
    let where = {};
    if (filter === 'downloading') where = { OR: [{ taskId: { not: null }, NOT: { taskId: 'DONE' } }] };
    else if (filter === 'failed') where = { retryCount: { gt: 0 }, NOT: { taskId: 'DONE' } };
    else where = { taskId: null };
    try {
        const [total, list] = await prisma.$transaction([
            prisma.pendingEpisode.count({ where }),
            prisma.pendingEpisode.findMany({ where, take, skip, orderBy: { createdAt: 'desc' } })
        ]);
        return { total, list };
    } catch (e) { return reply.code(500).send({ error: e.message }); }
});

app.post('/api/pending/delete', async (req, reply) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) return { status: 'ok', count: 0 };
    try {
        const result = await prisma.pendingEpisode.deleteMany({ where: { id: { in: ids } } });
        return { status: 'ok', count: result.count };
    } catch (e) { return reply.code(500).send({ status: 'error', message: e.message }); }
});

app.get('/api/config', async (req, reply) => {
    try {
        const configs = await prisma.systemConfig.findMany();
        const data = configs.reduce((acc, cur) => ({ ...acc, [cur.key]: cur.value }), {});
        return { success: true, data };
    } catch (e) { return reply.code(500).send({ success: false, message: e.message }); }
});

app.post('/api/config', async (req, reply) => {
    logger.info('[Config] 收到配置保存请求');
    const { configs } = req.body;
    if (!configs || typeof configs !== 'object') return reply.code(400).send({ success: false, message: "Invalid config object" });

    try {
        const operations = Object.entries(configs).map(([key, value]) => {
            return prisma.systemConfig.upsert({
                where: { key },
                update: { value: String(value || '') },
                create: { key, value: String(value || '') }
            });
        });
        await prisma.$transaction(operations);
        logger.info('[Config] 数据库配置更新成功');

        if (configs.hasOwnProperty('cloud189_token')) {
            const token = configs.cloud189_token;
            if (token && token.trim()) {
                await redis.set('auth:189:token', token.trim());
                logger.info('[Config] 189 Token 已同步到 Redis');
            } else {
                await redis.del('auth:189:token');
                logger.info('[Config] 189 Token 已从 Redis 移除');
            }
        }

        if (core123.reloadConfig) {
            await core123.reloadConfig();
            logger.info('[Config] Core123 服务已热重载');
        }
        metaCache.clear();
        return { success: true };
    } catch (e) {
        logger.error(e, `[Config] ❌ 保存失败`);
        return reply.code(500).send({ success: false, message: e.message });
    }
});

app.get('/api/offline/progress', async (req, reply) => {
    const taskID = req.query.taskID;
    const token = await core123.getVipToken(); 
    if(!taskID || !token) return { code: 1, message: "Missing params" };
    try {
        const res = await fetch(`https://open-api.123pan.com/api/v1/offline/download/process?taskID=${taskID}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Platform': 'open_platform' }
        });
        return await res.json();
    } catch(e) { return { code: 1, message: e.message }; }
});

app.post('/api/admin/sync', async (req, reply) => {
    if (isMaintenanceRunning) return reply.code(409).send({ error: "Another task is already running" });
    isMaintenanceRunning = true;
    try {
        const result = await runSyncStrm();
        return { status: 'ok', data: result };
    } catch (e) { return reply.code(500).send({ error: e.message }); } finally { isMaintenanceRunning = false; }
});

app.post('/api/admin/verify', async (req, reply) => {
    if (isMaintenanceRunning) return reply.code(409).send({ error: "Another task is already running" });
    isMaintenanceRunning = true;
    try {
        const result = await runVerifyStrm();
        return { status: 'ok', data: result };
    } catch (e) { return reply.code(500).send({ error: e.message }); } finally { isMaintenanceRunning = false; }
});

app.post('/api/do/', async (req, reply) => {
    const { action, tasks } = req.body; 
    if (action === 'ADD_TASKS') {
        if (!tasks || !Array.isArray(tasks)) return { success: false, message: "Tasks array required" };
        let count = 0;
        let skipped = 0;
        for (const t of tasks) {
            const current = await prisma.pendingEpisode.findUnique({ where: { id: t.id } });
            if (current && current.taskId && current.taskId !== 'null') { skipped++; continue; }
            await addToQueue({
                id: t.id, cleanName: t.name || t.cleanName, etag: t.etag, size: t.size, tmdbId: t.tmdbId, sourceType: t.sourceType, sourceRef: t.sourceRef, type: 'verify_rapid' 
            });
            await prisma.pendingEpisode.update({ where: { id: t.id }, data: { taskId: 'QUEUED' } });
            count++;
        }
        return { success: true, count };
    }
    return { success: false, message: `Unknown action: ${action}` };
});

async function handleMetadataMigration(newData, reqLogger) {
    const { tmdbId, name, year, genres, originalLanguage, originCountry } = newData;
    const oldSeries = await prisma.seriesMain.findUnique({ where: { tmdbId }, include: { episodes: true } });
    if (!oldSeries) return false;
    const isChanged = oldSeries.name !== name || oldSeries.year !== year || oldSeries.originalLanguage !== originalLanguage || oldSeries.originCountry !== originCountry || oldSeries.genres !== genres;
    if (isChanged) {
        logger.info({ tmdbId }, `[Migration] 元数据变更，清理旧 STRM...`);
        for (const ep of oldSeries.episodes) await strmService.deleteEpisode({ ...ep, series: oldSeries });
        return true; 
    }
    return false;
}

app.post('/api/submit', async (req, reply) => {
    const { tmdbId, jsonData, seriesName, seriesYear, type = 'tv', genres = '', sourceType = '123', originalLanguage, originCountry } = req.body;
    const isSourceTrusted = (sourceType === '123' || sourceType === 'json');
    const nowTime = new Date();
    const nowTimeISO = nowTime.toISOString();
    const fileCount = jsonData?.files?.length || 0;
    
    logger.info({ seriesName, fileCount, sourceType }, `[Submit] 📥 收到入库请求`);

    try {
        const needRegenerateAll = await handleMetadataMigration({ tmdbId, name: seriesName, year: seriesYear, genres, originalLanguage, originCountry }, req.log);
        let createdEpisodeIds = [];

        await prisma.$transaction(async (tx) => {
            logger.info('[Submit] 开始数据库事务 (Main & Episode)...');
            await tx.$executeRaw`
                INSERT INTO series_main (tmdb_id, name, year, type, genres, original_language, origin_country, last_updated) 
                VALUES (${tmdbId}, ${seriesName}, ${seriesYear}, ${type}, ${genres}, ${originalLanguage}, ${originCountry}, ${nowTimeISO})
                ON CONFLICT(tmdb_id) DO UPDATE SET 
                    name=excluded.name, year=excluded.year, type=excluded.type, genres=excluded.genres,
                    original_language=excluded.original_language, origin_country=excluded.origin_country,
                    last_updated=excluded.last_updated
                WHERE (series_main.last_updated < datetime(${nowTimeISO}, '-5 minutes')) OR series_main.last_updated IS NULL
            `;

            if (isSourceTrusted) {
                req.log.info('[Submit] >>> [可信来源] 正在写入数据库...');
                for (const file of jsonData.files) {
                    const { season, episode } = parseSeasonEpisode(file.clean_name, type);
                    const tier = file.type || 'video';
                    if (tier !== 'subtitle') await tx.seriesEpisode.deleteMany({ where: { tmdbId, season, episode, type: { not: 'subtitle' } } });
                    const newEp = await tx.seriesEpisode.create({
                        data: {
                            tmdbId, season, episode, cleanName: file.clean_name, etag: file.etag, size: BigInt(file.size), score: file.score || 0, type: tier, createdAt: nowTime
                        }
                    });
                    createdEpisodeIds.push(newEp.id);
                }
            } else {
                 req.log.info('[Submit] >>> 进入 [待验证] 分支...');
                 logger.info('[Submit] 进入待验证队列 (Worker Flow)...');
                 for (const file of jsonData.files) {
                    const { season, episode } = parseSeasonEpisode(file.clean_name, type);
                    const pending = await prisma.pendingEpisode.create({
                        data: {
                            tmdbId, season, episode, cleanName: file.clean_name, etag: file.etag, size: BigInt(file.size), score: file.score || 0, type: file.type || 'video', sourceType, sourceRef: file.source_ref || '', taskId: null
                        }
                    });
                    if (pending.id) {
                        await addToQueue({
                            id: pending.id, cleanName: file.clean_name, etag: file.etag, size: file.size, tmdbId, season, episode, score: file.score || 0, type: 'verify_rapid', sourceType, sourceRef: file.source_ref || ''
                        });
                        await prisma.pendingEpisode.update({ where: { id: pending.id }, data: { taskId: 'QUEUED' } });
                    }
                }
            }
        }, { maxWait: 20000, timeout: 60000 }); 
        logger.info('[Submit] ✅ 数据库事务已提交');

        if (isSourceTrusted && createdEpisodeIds.length > 0) {
            logger.info({ count: createdEpisodeIds.length }, `[Submit] 🛠️ 开始生成 STRM 文件`);
            let successCount = 0;
            let failCount = 0;
            for (const id of createdEpisodeIds) {
                try { await strmService.syncEpisode(id); successCount++; } catch (err) { failCount++; }
            }
            logger.info({ successCount, failCount }, `[Submit] STRM 生成完毕`);
        }

        if (needRegenerateAll) {
            logger.info(`[Migration] 🔄 重新生成全剧 STRM...`);
            const allEps = await prisma.seriesEpisode.findMany({ where: { tmdbId } });
            for (const ep of allEps) await strmService.syncEpisode(ep.id).catch(e => {});
        }

        let pendingCount = 0;
        if (!isSourceTrusted) pendingCount = fileCount;
        return { success: true, pendingCount };
    } catch (e) {
        logger.error(e, `[Submit] ❌ 提交处理失败`);
        return reply.code(500).send({ success: false, error: e.message });
    }
});

app.delete('/api/delete/series', async (req, reply) => {
    const id = parseInt(req.query.id);
    if (!id) return { error: "Missing ID" };
    
    // 1. 删除物理文件
    const episodes = await prisma.seriesEpisode.findMany({ where: { tmdbId: id }, include: { series: true } });
    for (const ep of episodes) await strmService.deleteEpisode(ep);
    
    // 2. 删除数据库记录
    // [修复] 使用 deleteMany 防止 "Record to delete does not exist" 错误
    await prisma.$transaction([
        prisma.seriesEpisode.deleteMany({ where: { tmdbId: id } }),
        prisma.seriesMain.deleteMany({ where: { tmdbId: id } }) // 变更为 deleteMany
    ]);
    return { success: true, id };
});

app.delete('/api/delete/episode', async (req, reply) => {
    const id = parseInt(req.query.id);
    if (!id || isNaN(id)) return { error: "Missing Row ID" };
    const ep = await prisma.seriesEpisode.findUnique({ where: { id }, include: { series: true } });
    if (ep) {
        await strmService.deleteEpisode({ ...ep, series: ep.series });
        await prisma.seriesEpisode.delete({ where: { id } });
    }
    return { success: true, id };
});

app.post('/api/webhook/upload', async (req, reply) => {
    const { secret, file_name, path, etag, size } = req.body;
    logger.info({ file_name, size }, `[Webhook] 收到上传通知`);
    
    if (secret !== CALLBACK_SECRET) return reply.code(403).send({ error: 'Invalid Secret' });
    if (!file_name || !etag) return { status: 'error', message: 'Missing fields' };
    const tmdbMatch = file_name.match(RE_TMDB_TAG) || path.match(RE_TMDB_TAG);
    if (!tmdbMatch) return { status: 'error', message: 'Missing {tmdb=xxx} tag' };
    const tmdbId = parseInt(tmdbMatch[1]);
    const { season, episode } = parseSeasonEpisode(file_name, path.includes('Season') || path.includes('剧集') ? 'tv' : 'movie');
    const mediaType = (season > 0 || episode > 0) ? 'tv' : 'movie';
    const nowTime = new Date();
    
    let series = await prisma.seriesMain.findUnique({ where: { tmdbId } });
    if (!series) {
        const meta = await fetchTmdbMeta(tmdbId, mediaType);
        const name = meta ? (meta.name || meta.title) : file_name.split('.')[0];
        const year = meta ? (meta.first_air_date || meta.release_date || '').split('-')[0] : '';
        const genres = meta ? meta.genres.map(g => g.id).join(',') : '';
        const originalLanguage = meta ? meta.original_language : null;
        const originCountry = meta ? (meta.origin_country ? meta.origin_country.join(',') : null) : null;
        series = await prisma.seriesMain.create({
            data: { tmdbId, name, year, type: mediaType, genres, originalLanguage, originCountry, lastUpdated: nowTime }
        });
    } else {
        await prisma.seriesMain.update({ where: { tmdbId }, data: { lastUpdated: nowTime } });
    }

    const cleanTitle = series.name.replace(RE_CLEAN_NAME, '').replace(RE_SPACE, '.');
    const seString = mediaType === 'tv' ? `.S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : "";
    const ext = file_name.split('.').pop();
    const isSubtitle = ['srt','ass','ssa','sub','vtt'].includes(ext.toLowerCase());
    
    let standardizedName = "";
    let newScore = 0;
    
    if (isSubtitle) {
        const lang = detectSubtitleLanguage(file_name);
        standardizedName = `${cleanTitle}${seString}.${series.year}${lang}.${ext}`;
    } else {
        const analysis = analyzeName(file_name);
        const tags = analysis.tagsArray.join('.');
        standardizedName = `${cleanTitle}${seString}.${series.year}.${tags}.${ext}`;
        newScore = calculateScore(analysis, size, mediaType === 'movie');
        const currentEp = await prisma.seriesEpisode.findFirst({ where: { tmdbId, season, episode, type: { not: 'subtitle' } } });
        if (currentEp && newScore <= currentEp.score) {
            logger.info(`[Webhook] ⏭️ 分数较低，跳过覆盖`);
            return { status: 'skipped', reason: 'lower_score' };
        }
    }

    await prisma.$transaction(async (tx) => {
        if (!isSubtitle) await tx.seriesEpisode.deleteMany({ where: { tmdbId, season, episode, type: { not: 'subtitle' } } });
        const newEp = await tx.seriesEpisode.create({
            data: { tmdbId, season, episode, cleanName: standardizedName, etag, size: BigInt(size), score: newScore, type: isSubtitle ? 'subtitle' : 'video', createdAt: nowTime }
        });
        strmService.syncEpisode(newEp.id).catch(e => console.error(e));
    });
    await addToQueue({
        id: -1, cleanName: standardizedName, type: 'verify_rapid', etag, size, tmdbId, season, episode, score: newScore, sourceType: 'webhook'
    });
    return { status: 'ok', new_name: standardizedName };
});

app.get('/api/stream', async (req, reply) => {
    const { panType, shareUrl, sharePassword, cookie } = req.query;
    logger.info({ panType, shareUrl }, `[Stream] 收到解析请求`);
    const stream = new Readable({ read() {} });
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*'
    });
    stream.pipe(reply.raw);
    const writer = {
        write: async (chunk) => {
            const str = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
            return stream.push(str);
        },
        close: () => stream.push(null)
    };
    try {
        if (panType === '123') await create123RapidTransfer(shareUrl, sharePassword, writer);
        else if (panType === '189') await create189RapidTransfer(shareUrl, sharePassword, writer);
        else if (panType === 'quark') await createQuarkRapidTransfer(shareUrl, sharePassword, cookie, writer);
        else throw new Error(`不支持的网盘类型: ${panType}`);
        logger.info(`[Stream] 解析完成`);
    } catch (e) {
        logger.error(e, `[Stream] ❌ 解析异常`);
        stream.push(`data: ${JSON.stringify({ type: 'error', data: { message: e.message } })}\n\n`);
    } finally {
        writer.close();
    }
});

app.post('/api/callback/123', async (req, reply) => {
    const { id, key } = req.query;
    if (key !== CALLBACK_SECRET) return reply.code(403).send("Forbidden");
    const body = req.body;
    logger.info({ id, status: body.status }, `[Callback] 收到 123 离线下载回调`);
    await prisma.pendingEpisode.update({ where: { id: parseInt(id) }, data: { taskId: body.status === 0 ? 'DONE' : undefined } });
    return { code: 0 };
});

setInterval(() => {
    core123.recycleAllCacheFolders().catch(err => { logger.error(err, '❌ [Schedule] Daily cleanup failed'); });
}, 24 * 60 * 60 * 1000);

async function fetchTmdbMeta(id, type) {
    let apiKey = process.env.TMDB_API_KEY;
    try {
        const conf = await prisma.systemConfig.findUnique({ where: { key: 'tmdb_key' } });
        if (conf && conf.value) apiKey = conf.value;
    } catch(e) {}
    if (!apiKey) return null;
    const cacheKey = `tmdb:${type}:${id}`;
    if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);
    try {
        const res = await fetch(`https://api.themoviedb.org/3/${type}/${id}?api_key=${apiKey}&language=zh-CN`);
        if (res.ok) {
            const data = await res.json();
            metaCache.set(cacheKey, data);
            return data;
        }
    } catch (e) { console.error(e); }
    return null;
}

function parseSeasonEpisode(name, type) {
    const match = name.match(RE_SEASON_EPISODE);
    if (match) return { season: parseInt(match[1]), episode: parseInt(match[2]) };
    return type === 'movie' ? { season: 0, episode: 0 } : { season: 1, episode: 1 };
}

app.setNotFoundHandler((req, reply) => {
    if (req.raw.url.startsWith('/api')) {
        reply.code(404).send({ error: 'API Not Found' });
    } else {
        reply.sendFile('index.html');
    }
});

const start = async () => {
    try {
        await app.listen({ port: 3000, host: '0.0.0.0' });
        logger.info('🚀 服务已启动 http://localhost:3000');
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();