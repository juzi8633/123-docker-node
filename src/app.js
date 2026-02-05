// src/app.js
import Fastify from 'fastify';
import dotenv from 'dotenv';
import { Readable } from 'stream';
import path from 'path'; 
import { fileURLToPath } from 'url'; 
import fastifyStatic from '@fastify/static'; 
import fs from 'fs'; 
import crypto from 'node:crypto'; 

// [优化] 引入压缩插件，解决 XML 传输瓶颈
import fastifyCompress from '@fastify/compress'; 

// [修改] 引入新的精准清除函数 invalidateCacheByTmdbId
import { handleWebDavRequest, invalidateWebdavCache, invalidateCacheByTmdbId } from './webdav.js';

// 引入核心模块
import { addToQueue } from './queue.js';
import { prisma } from './db.js'; 
import redis from './redis.js';
import { core123 } from './services/core123.js';
import { createLogger } from './logger.js'; 

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

// 解决 Prisma BigInt 序列化问题
BigInt.prototype.toJSON = function () { return this.toString(); };

dotenv.config();

// [优化] 初始化高性能日志
const logger = createLogger('App');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// [修改] 增大 bodyLimit 以支持大 JSON 导入
const app = Fastify({ 
    logger: true, 
    bodyLimit: 50 * 1024 * 1024 // 50MB
});

// [修复 415 错误] 注册 XML 解析器以支持 WebDAV
app.addContentTypeParser(['application/xml', 'text/xml'], (req, payload, done) => {
    let data = '';
    payload.on('data', chunk => { data += chunk; });
    payload.on('end', () => {
        done(null, data);
    });
});

// [优化] 注册压缩插件
app.register(fastifyCompress, {
    global: true,
    threshold: 1024,
});

app.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/', 
    wildcard: false 
});

// [新增] WebDAV 路由
app.all('/webdav/*', {
    disableRequestLogging: true
}, async (req, reply) => {
    return handleWebDavRequest(req, reply);
});

const SECRET = process.env.SECRET;

const metaCache = new Map();

app.addHook('onReady', async () => {
    try {
        logger.info('正在检查 Redis 连接...');
        await redis.ping();
        
        logger.info('正在检查数据库连接...');
        // 使用 await 确保 DB 连接正常
        await prisma.$queryRaw`SELECT 1`; 
        
        if (core123.reloadConfig) {
            logger.info('触发 Core123 配置预加载...');
            await core123.reloadConfig();
            app.log.info('✅ [System] Core123 配置已加载');
        }

        // 初始化缓存目录
        await core123.initLinkCacheFolder();

        app.log.info('✅ [System] Redis & SQLite 连接成功');
        logger.info('系统启动完成');
    } catch (err) {
        app.log.error(err, '❌ [System] 启动失败');
        process.exit(1);
    }
});

app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url;
    // 白名单放行逻辑（保持不变）
    if (url.startsWith('/api/webhook/upload') || 
        url.startsWith('/api/webhook/emby') || 
        url.startsWith('/api/stream') || 
        url === '/' || 
        url.includes('/assets/') || 
        url.startsWith('/webdav') || 
        url === '/favicon.ico') return;

    // 修复后的鉴权逻辑
    if (SECRET && url.startsWith('/api') && req.headers['authorization'] !== SECRET) {
        // 🚨 必须在这里发送响应来拦截请求
        return reply.code(401).send({ error: 'Unauthorized: Invalid Secret' });
    }
});

app.get('/api/health', async (req, reply) => {
    return { status: 'running', service: '123-Node-Server (Multi-Pan Mode)' };
});


// 为高频查询接口添加 Response Schema，加速 JSON 序列化
app.get('/api/search', {
    schema: {
        querystring: {
            type: 'object',
            properties: {
                q: { type: 'string' },
                page: { type: 'integer' },
                size: { type: 'integer' }
            }
        },
        response: {
            200: {
                type: 'object',
                properties: {
                    total: { type: 'integer' },
                    page: { type: 'integer' },
                    size: { type: 'integer' },
                    list: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                tmdbId: { type: 'integer' },
                                name: { type: 'string' },
                                year: { type: 'string' },
                                type: { type: 'string' },
                                genres: { type: 'string' },
                                originalLanguage: { type: 'string', nullable: true },
                                originCountry: { type: 'string', nullable: true },
                                lastUpdated: { type: 'string', format: 'date-time' }
                            }
                        }
                    }
                }
            }
        }
    }
}, async (req, reply) => {
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

    if (filter === 'downloading') {
        where = { 
            taskId: { not: null, notIn: ['DONE', 'QUEUED'] } 
        };
    } 
    else if (filter === 'failed') {
        where = { 
            retryCount: { gt: 0 }, 
            taskId: null 
        };
    } 
    else { 
        where = { 
            OR: [
                { taskId: null },
                { taskId: 'QUEUED' }
            ]
        };
    }

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
    
    let finalConfigs = {};
    if (configs) {
        finalConfigs = { ...configs };
    } else {
        finalConfigs = { ...req.body };
    }
    
    try {
        const operations = Object.entries(finalConfigs).map(([key, value]) => {
            if (key === 'configs') return null;
            return prisma.systemConfig.upsert({
                where: { key },
                update: { value: String(value === undefined || value === null ? '' : value) },
                create: { key, value: String(value === undefined || value === null ? '' : value) }
            });
        }).filter(Boolean);

        await prisma.$transaction(operations);
        logger.info('[Config] 数据库配置更新成功');

        if (finalConfigs.hasOwnProperty('cloud189_token')) {
            const token = finalConfigs.cloud189_token;
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

app.post('/api/admin/clear-db', async (req, reply) => {
    logger.warn('[Admin] ⚠️ 收到清空媒体库请求 (Clear DB)...');
    try {
        const [epCount, mainCount] = await prisma.$transaction([
            prisma.seriesEpisode.deleteMany(),
            prisma.seriesMain.deleteMany()
        ]);
        
        logger.info({ epCount: epCount.count, mainCount: mainCount.count }, '[Admin] ✅ 数据库媒体表已清空');
        
        metaCache.clear();
        invalidateWebdavCache(); 

        return { 
            success: true, 
            message: "Library tables cleared.",
            stats: { 
                episodesDeleted: epCount.count, 
                seriesDeleted: mainCount.count 
            }
        };
    } catch (e) {
        logger.error(e, '[Admin] ❌ 清空数据库失败');
        return reply.code(500).send({ success: false, error: e.message });
    }
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
        logger.info({ tmdbId }, `[Migration] 元数据变更`);
        return true; 
    }
    return false;
}

app.post('/api/submit', async (req, reply) => {
    const { 
        tmdbId, jsonData, seriesName, seriesYear, 
        type = 'tv', genres = '', sourceType = '123', 
        originalLanguage, originCountry 
    } = req.body;

    const isSourceTrusted = (sourceType === '123' || sourceType === 'json');
    const nowTime = new Date();
    const files = jsonData?.files || [];
    const fileCount = files.length;
    
    logger.info({ seriesName, fileCount, sourceType }, `[Submit] 📥 收到入库请求 (安全分批版)`);

    try {
        const needRegenerateAll = await handleMetadataMigration({ 
            tmdbId, name: seriesName, year: seriesYear, genres, originalLanguage, originCountry 
        }, req.log);
        
        await prisma.seriesMain.upsert({
            where: { tmdbId },
            update: {
                name: seriesName, year: seriesYear, type, genres, 
                originalLanguage, originCountry, lastUpdated: nowTime
            },
            create: {
                tmdbId, name: seriesName, year: seriesYear, type, genres, 
                originalLanguage, originCountry, lastUpdated: nowTime
            }
        });
        
        let pendingCount = 0;       
        
        const BATCH_SIZE = 50; 

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
            const batchFiles = files.slice(i, i + BATCH_SIZE);
            const batchQueueTasks = []; 

            await prisma.$transaction(async (tx) => {
                if (isSourceTrusted) {
                    const videosMap = new Map(); 
                    const subtitlesList = [];
                    const deleteSet = new Set(); 

                    for (const file of batchFiles) {
                        const { season, episode } = parseSeasonEpisode(file.clean_name, type);
                        const tier = file.type || 'video';
                        
                        if (tier === 'subtitle') {
                            subtitlesList.push({
                                tmdbId, season, episode, cleanName: file.clean_name, 
                                etag: file.etag, size: BigInt(file.size), score: file.score || 0, 
                                type: tier, createdAt: nowTime, S3KeyFlag: file.S3KeyFlag || ''
                            });
                        } else {
                            const key = `${season}|${episode}`;
                            deleteSet.add(key);
                            videosMap.set(key, {
                                tmdbId, season, episode, cleanName: file.clean_name, 
                                etag: file.etag, size: BigInt(file.size), score: file.score || 0, 
                                type: tier, createdAt: nowTime, S3KeyFlag: file.S3KeyFlag || ''
                            });
                        }
                    }

                    if (deleteSet.size > 0) {
                        const orConditions = Array.from(deleteSet).map(s => {
                            const [season, episode] = s.split('|').map(Number);
                            return { season, episode };
                        });
                        
                        await tx.seriesEpisode.deleteMany({
                            where: {
                                tmdbId,
                                type: { not: 'subtitle' },
                                OR: orConditions
                            }
                        });
                    }

                    const toInsert = [...videosMap.values(), ...subtitlesList];
                    if (toInsert.length > 0) {
                        await tx.seriesEpisode.createMany({
                            data: toInsert
                        });
                    }

                } else {
                    for (const file of batchFiles) {
                        const { season, episode } = parseSeasonEpisode(file.clean_name, type);
                        
                        const pending = await tx.pendingEpisode.create({
                            data: {
                                tmdbId, season, episode, cleanName: file.clean_name, 
                                etag: file.etag, size: BigInt(file.size), score: file.score || 0, 
                                type: file.type || 'video', sourceType, sourceRef: file.source_ref || '', 
                                taskId: 'QUEUED' 
                            }
                        });

                        if (pending.id) {
                            batchQueueTasks.push({
                                id: pending.id, cleanName: file.clean_name, 
                                etag: file.etag, size: file.size, tmdbId, season, episode, 
                                score: file.score || 0, type: 'verify_rapid', 
                                sourceType, sourceRef: file.source_ref || ''
                            });
                            pendingCount++;
                        }
                    }
                }
            }, { maxWait: 5000, timeout: 10000 }); 

            if (batchQueueTasks.length > 0) {
                await Promise.all(batchQueueTasks.map(task => addToQueue(task)));
            }

            await new Promise(r => setTimeout(r, 10));
        }

        logger.info('[Submit] ✅ 数据库写入完成，开始后续处理...');

        if (tmdbId) {
            // [修改] 确保调用正确的清理函数，使 WebDAV 立即生效
            invalidateCacheByTmdbId(tmdbId).catch(err => logger.warn({ tmdbId, err }, 'Cache invalidation failed'));
        } else {
            invalidateWebdavCache(); 
        }

        return { success: true, pendingCount: isSourceTrusted ? 0 : pendingCount };

    } catch (e) {
        logger.error(e, `[Submit] ❌ 提交处理失败`);
        return reply.code(500).send({ success: false, error: e.message });
    }
});

app.delete('/api/delete/series', async (req, reply) => {
    const id = parseInt(req.query.id);
    if (!id) return { error: "Missing ID" };
    
    await prisma.$transaction([
        prisma.seriesEpisode.deleteMany({ where: { tmdbId: id } }),
        prisma.seriesMain.deleteMany({ where: { tmdbId: id } }) 
    ]);

    if (id) {
        await invalidateCacheByTmdbId(id);
    } else {
        invalidateWebdavCache();
    }

    return { success: true, id };
});

app.delete('/api/delete/episode', async (req, reply) => {
    const id = parseInt(req.query.id);
    if (!id || isNaN(id)) return { error: "Missing Row ID" };
    const ep = await prisma.seriesEpisode.findUnique({ where: { id } });
    
    let tmdbId = null;

    if (ep) {
        tmdbId = ep.tmdbId; 
        await prisma.seriesEpisode.delete({ where: { id } });
    }

    if (tmdbId) {
        await invalidateCacheByTmdbId(tmdbId);
    } else {
        invalidateWebdavCache();
    }

    return { success: true, id };
});

app.post('/api/webhook/upload', async (req, reply) => {
    const { secret, file_name, path, etag, size, s3_key_flag='' } = req.body;
    logger.info({ file_name, size }, `[Webhook] 收到上传通知`);
    
    if (secret !== SECRET) return reply.code(403).send({ error: 'Invalid Secret' });
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
        const name = meta.name || meta.title;
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
            data: { tmdbId, season, episode, cleanName: standardizedName, etag, size: BigInt(size), score: newScore, type: isSubtitle ? 'subtitle' : 'video', createdAt: nowTime ,S3KeyFlag: s3_key_flag || "" }
        });
    });
    await addToQueue({
        id: -1, cleanName: standardizedName, type: 'verify_rapid', etag, size, tmdbId, season, episode, score: newScore, sourceType: 'webhook'
    });

    if (tmdbId) {
        await invalidateCacheByTmdbId(tmdbId);
    } else {
        invalidateWebdavCache();
    }

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
    if (key !== SECRET) return reply.code(403).send("Forbidden");
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
    if (req.raw.url.startsWith('/api') || req.raw.url.startsWith('/webdav')) {
        reply.code(404).send({ error: 'API/WebDAV Not Found' });
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
