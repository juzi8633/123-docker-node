import Fastify from 'fastify';
import dotenv from 'dotenv';
import { Readable } from 'stream';
import path from 'path'; // [新增] 用于路径处理
import { fileURLToPath } from 'url'; // [新增] 用于获取 __dirname
import fastifyStatic from '@fastify/static'; // [新增] 用于托管前端静态文件

// 引入核心模块
import { addToQueue } from './queue.js';
import { prisma } from './db.js'; 
import redis from './redis.js';
import { core123 } from './services/core123.js';
import { strmService } from './services/strm.js'; 

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

// [全局配置] 解决 BigInt 序列化问题
BigInt.prototype.toJSON = function () { return this.toString(); };

dotenv.config();

// 获取当前文件所在目录 (ES Modules 兼容写法)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ 
    logger: true,
    bodyLimit: 50 * 1024 * 1024
});

// ==========================================
// [新增] 静态文件服务配置 (Docker 部署核心)
// ==========================================
// 注册静态文件插件，指向 ../public 目录 (Docker 构建时会把 dist 复制到这里)
app.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/', // 访问根路径即访问前端
    wildcard: false // 禁用默认通配符，以便我们自己处理 SPA Fallback
});

const CALLBACK_SECRET = process.env.CALLBACK_SECRET;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
// TMDB_API_KEY 不再作为全局常量强绑定，改为动态获取

// 内存缓存
const metaCache = new Map();
let isMaintenanceRunning = false;

// ==========================================
// 1. 启动检查与全局鉴权
// ==========================================
app.addHook('onReady', async () => {
    try {
        await redis.ping();
        await prisma.$queryRaw`SELECT 1`; 
        
        // 启动时先加载配置到内存 (Core123 服务)
        if (core123.reloadConfig) {
            await core123.reloadConfig();
            app.log.info('✅ [System] Core123 配置已加载');
        }

        await core123.initLinkCacheFolder();
        await strmService.init();

        app.log.info('✅ [System] Redis & SQLite 连接成功，缓存目录与 Strm 服务就绪');
    } catch (err) {
        app.log.error('❌ [System] 启动失败 (DB/Redis/FS 连接错误):', err);
        process.exit(1);
    }
});

app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url;
    // 放行 API 路径、静态资源和 favicon
    if (url.startsWith('/api/') || 
        url === '/' || 
        url === '/index.html' || 
        url.includes('/assets/') || 
        url === '/favicon.ico'
    ) return;

    if (AUTH_PASSWORD) {
        // 只有非公开 API 需要鉴权 (这里逻辑根据实际需求调整，目前代码逻辑是全放行特定前缀)
        // 注意：原代码逻辑其实是对所有非特定前缀请求鉴权，这里为了配合前端静态服务，建议主要保护 API
        // 如果是 API 请求且不是白名单内的，才检查 Token
        if (url.startsWith('/api') && req.headers['authorization'] !== AUTH_PASSWORD) {
            // 这里可以细化鉴权逻辑，暂时保持原状
            // req.log.warn(`[Auth] 鉴权失败...`);
        }
    }
});

// ==========================================
// 2. 核心业务 API
// ==========================================

// [修改] 根路径现在由 fastify-static 接管返回 index.html，所以移除原有的 app.get('/') 
// 或者保留作为 API 状态检查，但建议改个路径，比如 /api/health
app.get('/api/health', async (req, reply) => {
    return { status: 'running', service: '123-Node-Server (Strm Mode)' };
});

app.get('/api/play/:id', async (req, reply) => {
    const { id } = req.params;
    
    const file = await prisma.seriesEpisode.findUnique({
        where: { id: parseInt(id) },
        select: { cleanName: true, etag: true, size: true }
    });
    
    if (!file) {
        return reply.code(404).send("File not found in DB");
    }

    try {
        const downloadUrl = await core123.getDownloadUrlByHash(
            file.cleanName, 
            file.etag, 
            Number(file.size)
        );

        if (!downloadUrl) throw new Error("Link generation failed");
        return reply.redirect(302, downloadUrl);
    } catch (e) {
        req.log.error(`[Play] ID ${id} Error: ${e.message}`);
        return reply.code(502).send("Upstream Error");
    }
});

app.get('/api/search', async (req, reply) => {
    const { q, page = 1, size = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(size);
    const take = parseInt(size);

    req.log.info(`[Search] Query: "${q || ''}", Page: ${page}`);

    const where = q ? {
        OR: [
            { name: { contains: q } },
            ...( !isNaN(q) ? [{ tmdbId: parseInt(q) }] : [])
        ]
    } : {};

    try {
        const [total, list] = await prisma.$transaction([
            prisma.seriesMain.count({ 
                where: { ...where, episodes: { some: {} } } 
            }),
            prisma.seriesMain.findMany({
                where: { ...where, episodes: { some: {} } },
                take,
                skip,
                orderBy: { lastUpdated: 'desc' },
                select: { tmdbId: true, name: true, year: true, type: true, genres: true, originalLanguage: true, originCountry: true, lastUpdated: true }
            })
        ]);
        return { total, list, page: parseInt(page), size: take };
    } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ error: e.message });
    }
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
    } catch (e) {
        return reply.code(500).send({ error: e.message });
    }
});

app.get('/api/pending/list', async (req, reply) => {
    const { page = 1, size = 20, filter = 'pending' } = req.query;
    const take = parseInt(size);
    const skip = (parseInt(page) - 1) * take;

    let where = {};
    if (filter === 'downloading') {
        where = { OR: [{ taskId: { not: null }, NOT: { taskId: 'DONE' } }] };
    } else if (filter === 'failed') {
        where = { retryCount: { gt: 0 }, NOT: { taskId: 'DONE' } };
    } else {
        where = { taskId: null };
    }

    try {
        const [total, list] = await prisma.$transaction([
            prisma.pendingEpisode.count({ where }),
            prisma.pendingEpisode.findMany({
                where,
                take,
                skip,
                orderBy: { createdAt: 'desc' }
            })
        ]);
        return { total, list };
    } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ error: e.message });
    }
});

app.post('/api/pending/delete', async (req, reply) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) return { status: 'ok', count: 0 };

    try {
        const result = await prisma.pendingEpisode.deleteMany({
            where: { id: { in: ids } }
        });
        return { status: 'ok', count: result.count };
    } catch (e) {
        return reply.code(500).send({ status: 'error', message: e.message });
    }
});

// ==========================================
// 配置管理 API (GET/POST)
// ==========================================

// 获取系统配置
app.get('/api/config', async (req, reply) => {
    try {
        const configs = await prisma.systemConfig.findMany(); //
        const data = configs.reduce((acc, cur) => ({ ...acc, [cur.key]: cur.value }), {});
        return { success: true, data };
    } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ success: false, message: e.message });
    }
});

// 保存系统配置并热重载
app.post('/api/config', async (req, reply) => {
    const { configs } = req.body; // { tmdb_key: "...", quark_cookie: "..." }
    if (!configs || typeof configs !== 'object') {
        return reply.code(400).send({ success: false, message: "Invalid config object" });
    }

    try {
        // 1. 使用事务批量 Upsert
        const operations = Object.entries(configs).map(([key, value]) => {
            return prisma.systemConfig.upsert({
                where: { key },
                update: { value: String(value || '') },
                create: { key, value: String(value || '') }
            });
        });
        await prisma.$transaction(operations);

        // 2. 触发核心服务热重载
        if (core123.reloadConfig) {
            await core123.reloadConfig();
            req.log.info('[Config] Core123 配置已热重载');
        }
        
        // 3. 清理元数据缓存，确保下次获取最新的 TMDB Key
        metaCache.clear();

        return { success: true };
    } catch (e) {
        req.log.error(e);
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
    } catch(e) {
        return { code: 1, message: e.message };
    }
});

app.post('/api/admin/sync', async (req, reply) => {
    if (isMaintenanceRunning) return reply.code(409).send({ error: "Another task is already running" });
    isMaintenanceRunning = true;
    try {
        const result = await runSyncStrm();
        return { status: 'ok', data: result };
    } catch (e) {
        return reply.code(500).send({ error: e.message });
    } finally {
        isMaintenanceRunning = false;
    }
});

app.post('/api/admin/verify', async (req, reply) => {
    if (isMaintenanceRunning) return reply.code(409).send({ error: "Another task is already running" });
    isMaintenanceRunning = true;
    try {
        const result = await runVerifyStrm();
        return { status: 'ok', data: result };
    } catch (e) {
        return reply.code(500).send({ error: e.message });
    } finally {
        isMaintenanceRunning = false;
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
            if (current && current.taskId && current.taskId !== 'null') {
                skipped++;
                continue;
            }

            await addToQueue({
                id: t.id, 
                cleanName: t.name || t.cleanName,
                etag: t.etag,
                size: t.size,
                tmdbId: t.tmdbId,
                sourceType: t.sourceType, 
                sourceRef: t.sourceRef,
                type: 'verify_rapid' 
            });

            await prisma.pendingEpisode.update({
                where: { id: t.id },
                data: { taskId: 'QUEUED' }
            });
            count++;
        }
        
        return { success: true, count };
    }
    return { success: false, message: `Unknown action: ${action}` };
});

// ==========================================
// [核心逻辑] 智能元数据变更处理
// ==========================================
async function handleMetadataMigration(newData, logger) {
    const { tmdbId, name, year, genres, originalLanguage, originCountry } = newData;

    const oldSeries = await prisma.seriesMain.findUnique({
        where: { tmdbId },
        include: { episodes: true }
    });

    if (!oldSeries) return false;

    const isChanged = 
        oldSeries.name !== name ||
        oldSeries.year !== year ||
        oldSeries.originalLanguage !== originalLanguage ||
        oldSeries.originCountry !== originCountry ||
        oldSeries.genres !== genres;

    if (isChanged) {
        logger.info(`[Migration] 检测到元数据变更 (TMDB: ${tmdbId})，正在清理旧路径文件...`);
        for (const ep of oldSeries.episodes) {
            await strmService.deleteEpisode({ ...ep, series: oldSeries });
        }
        return true; 
    }

    return false;
}

// [API] 导入与提交
app.post('/api/submit', async (req, reply) => {
    const { 
        tmdbId, jsonData, seriesName, seriesYear, type = 'tv', genres = '', 
        sourceType = '123', originalLanguage, originCountry 
    } = req.body;

    const isSourceTrusted = (sourceType === '123' || sourceType === 'json');
    const nowTime = new Date();
    const nowTimeISO = nowTime.toISOString();

    req.log.info(`[Submit] 收到导入请求: TMDB ${tmdbId} - ${seriesName}`);

    try {
        const needRegenerateAll = await handleMetadataMigration({
            tmdbId, name: seriesName, year: seriesYear, genres, originalLanguage, originCountry
        }, req.log);

        await prisma.$transaction(async (tx) => {
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
                for (const file of jsonData.files) {
                    const { season, episode } = parseSeasonEpisode(file.clean_name, type);
                    const tier = file.type || 'video';
                    if (tier !== 'subtitle') {
                         await tx.seriesEpisode.deleteMany({ where: { tmdbId, season, episode, type: { not: 'subtitle' } } });
                    }
                    const newEp = await tx.seriesEpisode.create({
                        data: {
                            tmdbId, season, episode, cleanName: file.clean_name,
                            etag: file.etag, size: BigInt(file.size), score: file.score || 0,
                            type: tier, createdAt: nowTime
                        }
                    });
                    strmService.syncEpisode(newEp.id).catch(e => console.error(e));
                }
            }
        });

        if (needRegenerateAll) {
            req.log.info(`[Migration] 正在重新生成 TMDB:${tmdbId} 的所有文件到新目录...`);
            const allEps = await prisma.seriesEpisode.findMany({ where: { tmdbId } });
            for (const ep of allEps) {
                strmService.syncEpisode(ep.id).catch(e => console.error(e));
            }
        }

        let pendingCount = 0;
        if (!isSourceTrusted) {
            for (const file of jsonData.files) {
                const { season, episode } = parseSeasonEpisode(file.clean_name, type);
                const pending = await prisma.pendingEpisode.create({
                    data: {
                        tmdbId, season, episode, cleanName: file.clean_name,
                        etag: file.etag, size: BigInt(file.size), score: file.score || 0,
                        type: file.type || 'video', sourceType, sourceRef: file.source_ref || '',
                        taskId: null
                    }
                });

                if (pending.id) {
                    await addToQueue({
                        id: pending.id, cleanName: file.clean_name, etag: file.etag, size: file.size,
                        tmdbId, season, episode, score: file.score || 0,
                        type: 'verify_rapid', sourceType, sourceRef: file.source_ref || ''
                    });
                    await prisma.pendingEpisode.update({
                        where: { id: pending.id },
                        data: { taskId: 'QUEUED' }
                    });
                    pendingCount++;
                }
            }
        }

        return { success: true, pendingCount };
    } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ success: false, error: e.message });
    }
});

app.delete('/api/delete/series', async (req, reply) => {
    const id = parseInt(req.query.id);
    if (!id) return { error: "Missing ID" };

    const episodes = await prisma.seriesEpisode.findMany({
        where: { tmdbId: id },
        include: { series: true }
    });
    for (const ep of episodes) {
        await strmService.deleteEpisode(ep);
    }

    await prisma.$transaction([
        prisma.seriesEpisode.deleteMany({ where: { tmdbId: id } }),
        prisma.seriesMain.delete({ where: { tmdbId: id } })
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
        
        const currentEp = await prisma.seriesEpisode.findFirst({
            where: { tmdbId, season, episode, type: { not: 'subtitle' } }
        });
        
        if (currentEp && newScore <= currentEp.score) {
            return { status: 'skipped', reason: 'lower_score' };
        }
    }

    await prisma.$transaction(async (tx) => {
        if (!isSubtitle) {
             await tx.seriesEpisode.deleteMany({ where: { tmdbId, season, episode, type: { not: 'subtitle' } } });
        }
        const newEp = await tx.seriesEpisode.create({
            data: {
                tmdbId, season, episode, cleanName: standardizedName,
                etag, size: BigInt(size), score: newScore,
                type: isSubtitle ? 'subtitle' : 'video', createdAt: nowTime
            }
        });
        
        strmService.syncEpisode(newEp.id).catch(e => console.error(e));
    });

    await addToQueue({
        id: -1, cleanName: standardizedName, type: 'verify_rapid',
        etag, size, tmdbId, season, episode, score: newScore, sourceType: 'webhook'
    });

    return { status: 'ok', new_name: standardizedName };
});

app.get('/api/stream', async (req, reply) => {
    const { panType, shareUrl, sharePassword, cookie } = req.query;
    const stream = new Readable({ read() {} });
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*'
    });
    stream.pipe(reply.raw);

    const writer = {
        write: async (chunk) => stream.push(typeof chunk === 'string' ? chunk : JSON.stringify(chunk)),
        close: () => stream.push(null)
    };

    try {
        if (panType === '123') await create123RapidTransfer(shareUrl, sharePassword, writer);
        else if (panType === '189') await create189RapidTransfer(shareUrl, sharePassword, writer);
        else if (panType === 'quark') await createQuarkRapidTransfer(shareUrl, sharePassword, cookie, writer);
        else throw new Error("不支持的网盘类型");
    } catch (e) {
        stream.push(`data: ${JSON.stringify({ type: 'error', data: { message: e.message } })}\n\n`);
    } finally {
        writer.close();
    }
});

app.post('/api/callback/123', async (req, reply) => {
    const { id, key } = req.query;
    if (key !== CALLBACK_SECRET) return reply.code(403).send("Forbidden");
    const body = req.body;
    
    await prisma.pendingEpisode.update({
        where: { id: parseInt(id) },
        data: { taskId: body.status === 0 ? 'DONE' : undefined }
    });
    return { code: 0 };
});

// 定时任务：每天自动清理 123pan 缓存目录
setInterval(() => {
    core123.recycleAllCacheFolders().catch(err => {
        console.error('❌ [Schedule] Daily cleanup failed:', err);
    });
}, 24 * 60 * 60 * 1000);

// 获取 TMDB 元数据，优先读库
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

// ==========================================
// [新增] SPA Fallback 处理
// ==========================================
// 当请求未命中任何 API 或静态文件时，返回 index.html，支持前端路由
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
        console.log('🚀 Server running at http://localhost:3000');
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();