import Fastify from 'fastify';
import dotenv from 'dotenv';
import { Readable } from 'stream';

// 引入核心模块
import { addToQueue } from './queue.js';
import { prisma } from './db.js'; 
import redis from './redis.js';
import { core123 } from './services/core123.js';
import { create123RapidTransfer } from "./services/service123.js";
import { create189RapidTransfer } from "./services/service189.js";
import { createQuarkRapidTransfer } from "./services/serviceQuark.js";

// 引入 WebDAV 处理器
import { handleWebDav } from './webdav.js'; 

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

// [全局配置] 解决 BigInt 序列化问题 (Prisma 返回的 size 是 BigInt)
BigInt.prototype.toJSON = function () { return this.toString(); };

dotenv.config();

const app = Fastify({ 
    logger: true, // 开启 Fastify 默认日志
    bodyLimit: 50 * 1024 * 1024 // 50MB Body 限制，防止大 JSON 导致 Payload Too Large
});

const CALLBACK_SECRET = process.env.CALLBACK_SECRET;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// 内存缓存 (用于 TMDB 元数据缓存，减少 API 调用)
const metaCache = new Map();

// ==========================================
// 1. 启动检查与全局鉴权
// ==========================================
app.addHook('onReady', async () => {
    try {
        await redis.ping();
        // 简单查询测试数据库连接
        await prisma.$queryRaw`SELECT 1`; 
        app.log.info('✅ [System] Redis & SQLite 连接成功，服务启动就绪');
    } catch (err) {
        app.log.error('❌ [System] 启动失败 (DB/Redis 连接错误):', err);
        process.exit(1);
    }
});

app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url;
    // 白名单路径 (WebDAV 自带鉴权，API 回调不需要 Auth Header)
    if (url.startsWith('/webdav') || 
        url.startsWith('/api/stream') ||
        url.startsWith('/api/callback') ||
        url.startsWith('/api/offline') ||
        url === '/' || url === '/favicon.ico'
    ) return;

    // 全局 API 鉴权
    if (AUTH_PASSWORD) {
        if (req.headers['authorization'] !== AUTH_PASSWORD) {
            req.log.warn(`[Auth] 鉴权失败: IP ${req.ip} 尝试访问 ${url}`);
            reply.code(401).send({ error: "Unauthorized" });
        }
    }
});

// ==========================================
// 2. WebDAV 路由接管
// ==========================================
app.all('/webdav*', async (req, reply) => {
    // 调用 node_webdav.js 的处理逻辑
    await handleWebDav(req, reply);
});

// ==========================================
// 3. 核心业务 API
// ==========================================

// [API] 根路径状态检查
app.get('/', async (req, reply) => {
    return { status: 'running', service: '123-Node-Server' };
});

// [API] 搜索剧集 (已修复：只返回包含文件的剧集)
app.get('/api/search', async (req, reply) => {
    const { q, page = 1, size = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(size);
    const take = parseInt(size);

    // 记录搜索请求
    req.log.info(`[Search] Query: "${q || ''}", Page: ${page}`);

    const where = q ? {
        OR: [
            { name: { contains: q } },
            ...( !isNaN(q) ? [{ tmdbId: parseInt(q) }] : [])
        ]
    } : {};

    try {
        // 关键逻辑：episodes: { some: {} } 确保只显示有入库文件的剧集
        const [total, list] = await prisma.$transaction([
            prisma.seriesMain.count({ 
                where: { ...where, episodes: { some: {} } } 
            }),
            prisma.seriesMain.findMany({
                where: { ...where, episodes: { some: {} } },
                take,
                skip,
                orderBy: { lastUpdated: 'desc' },
                select: { tmdbId: true, name: true, year: true, type: true, genres: true, lastUpdated: true }
            })
        ]);
        return { total, list, page: parseInt(page), size: take };
    } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ error: e.message });
    }
});

// [API] 获取剧集详情
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
        
        // 记录详情访问
        req.log.info(`[Details] ID: ${id}, Name: ${seriesInfo.name}, Files: ${episodes.length}`);
        
        return { info: seriesInfo, episodes };
    } catch (e) {
        return reply.code(500).send({ error: e.message });
    }
});

// [API] 获取任务列表 (VerificationView 用)
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

// [API] 批量删除待处理任务
app.post('/api/pending/delete', async (req, reply) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) return { status: 'ok', count: 0 };

    try {
        const result = await prisma.pendingEpisode.deleteMany({
            where: { id: { in: ids } }
        });
        req.log.info(`[Pending] 批量删除了 ${result.count} 个任务`);
        return { status: 'ok', count: result.count };
    } catch (e) {
        return reply.code(500).send({ status: 'error', message: e.message });
    }
});

// [API] 配置同步 (前端保存配置时同步到 Redis)
app.post('/api/config/update', async (req, reply) => {
    const { quark_cookie, ty_token, open123_dir_id } = req.body;
    
    const updates = [];
    if (quark_cookie) { await redis.set('auth:quark:cookie', quark_cookie); updates.push('Quark Cookie'); }
    if (ty_token) { await redis.set('auth:189:token', ty_token); updates.push('189 Token'); }
    if (open123_dir_id) { await redis.set('123:current_dir_id', open123_dir_id); updates.push('Dir ID'); }
    
    req.log.info(`[Config] 更新了配置项: ${updates.join(', ')}`);
    return { success: true };
});

// [API] 离线下载进度查询
app.get('/api/offline/progress', async (req, reply) => {
    const taskID = req.query.taskID;
    const token = await core123.getAccessToken();
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

// ==========================================
// [API] 任务调度 (手动触发)
// ==========================================
app.post('/api/do/', async (req, reply) => {
    const { action, tasks, auth } = req.body;

    // 1. 同步鉴权信息
    if (auth) {
        if (auth.quark_cookie) await redis.set('auth:quark:cookie', auth.quark_cookie);
        if (auth.ty_token) await redis.set('auth:189:token', auth.ty_token);
        if (auth.dir_id) await redis.set('123:current_dir_id', auth.dir_id);
    }

    if (action === 'ADD_TASKS') {
        if (!tasks || !Array.isArray(tasks)) return { success: false, message: "Tasks array required" };
        
        let count = 0;
        let skipped = 0;
        for (const t of tasks) {
            // [关键逻辑] 防止重复提交
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

            // [关键逻辑] 入队后立即标记为 QUEUED
            await prisma.pendingEpisode.update({
                where: { id: t.id },
                data: { taskId: 'QUEUED' }
            });
            
            count++;
        }
        
        req.log.info(`[Dispatcher] 手动调度: 新增 ${count} 个, 跳过 ${skipped} 个 (防重复)`);
        return { success: true, count };
    }
    return { success: false, message: `Unknown action: ${action}` };
});

// ==========================================
// [API] 导入与提交 (自动运行逻辑)
// ==========================================
app.post('/api/submit', async (req, reply) => {
    const { tmdbId, jsonData, seriesName, seriesYear, type = 'tv', genres = '', sourceType = '123' } = req.body;
    const isSourceTrusted = (sourceType === '123' || sourceType === 'json');
    const nowTime = new Date();
    const nowTimeISO = nowTime.toISOString();

    req.log.info(`[Submit] 收到导入请求: TMDB ${tmdbId} - ${seriesName}, 来源: ${sourceType}, 文件数: ${jsonData?.files?.length}`);

    try {
        await prisma.$transaction(async (tx) => {
            // 1. 写入 SeriesMain (无论是否信任，都需要创建剧集壳)
            await tx.$executeRaw`
                INSERT INTO series_main (tmdb_id, name, year, type, genres, last_updated) 
                VALUES (${tmdbId}, ${seriesName}, ${seriesYear}, ${type}, ${genres}, ${nowTimeISO})
                ON CONFLICT(tmdb_id) DO UPDATE SET 
                    name=excluded.name, year=excluded.year, type=excluded.type, genres=excluded.genres, last_updated=excluded.last_updated
                WHERE (series_main.last_updated < datetime(${nowTimeISO}, '-5 minutes')) OR series_main.last_updated IS NULL
            `;

            // 2. 更新目录时间 (Folder Meta)
            const metaKeys = [`root:${type}`];
            if (genres) {
                const genreList = genres.split(',').map(g => parseInt(g.trim())).filter(g => !isNaN(g));
                for (const gid of genreList) {
                    await tx.$executeRaw`INSERT OR IGNORE INTO series_genres (tmdb_id, genre_id, type) VALUES (${tmdbId}, ${gid}, ${type})`;
                    if (seriesYear) await tx.$executeRaw`INSERT OR IGNORE INTO stats_genre_years (genre_id, type, year) VALUES (${gid}, ${type}, ${seriesYear})`;
                    
                    metaKeys.push(`genre:${type}:${gid}`);
                    if (seriesYear) metaKeys.push(`year:${type}:${gid}:${seriesYear}`);
                }
            }
            for (const key of metaKeys) {
                await tx.$executeRaw`
                    INSERT INTO folder_meta (key, last_updated) VALUES (${key}, ${nowTimeISO})
                    ON CONFLICT(key) DO UPDATE SET last_updated = excluded.last_updated
                    WHERE folder_meta.last_updated < datetime(excluded.last_updated, '-5 minutes')
                `;
            }

            // 3. 信任源直接入库
            if (isSourceTrusted) {
                for (const file of jsonData.files) {
                    const { season, episode } = parseSeasonEpisode(file.clean_name, type);
                    const tier = file.type || 'video';
                    if (tier !== 'subtitle') {
                         await tx.seriesEpisode.deleteMany({ where: { tmdbId, season, episode, type: { not: 'subtitle' } } });
                    }
                    await tx.seriesEpisode.create({
                        data: {
                            tmdbId, season, episode, cleanName: file.clean_name,
                            etag: file.etag, size: BigInt(file.size), score: file.score || 0,
                            type: tier, createdAt: nowTime
                        }
                    });
                }
            }
        });

        // 4. 非信任源 -> 写入 Pending -> 自动入队 -> 标记为 QUEUED
        let pendingCount = 0;
        if (!isSourceTrusted) {
            for (const file of jsonData.files) {
                const { season, episode } = parseSeasonEpisode(file.clean_name, type);
                
                const pending = await prisma.pendingEpisode.create({
                    data: {
                        tmdbId, season, episode, cleanName: file.clean_name,
                        etag: file.etag, size: BigInt(file.size), score: file.score || 0,
                        type: file.type || 'video', sourceType, sourceRef: file.source_ref || '',
                        taskId: null // 初始状态
                    }
                });

                if (pending.id) {
                    // [关键] 自动入队
                    await addToQueue({
                        id: pending.id, cleanName: file.clean_name, etag: file.etag, size: file.size,
                        tmdbId, season, episode, score: file.score || 0,
                        type: 'verify_rapid', sourceType, sourceRef: file.source_ref || ''
                    });

                    // [关键] 立即标记为 QUEUED
                    await prisma.pendingEpisode.update({
                        where: { id: pending.id },
                        data: { taskId: 'QUEUED' }
                    });

                    pendingCount++;
                }
            }
            req.log.info(`[Submit] 自动调度: 已将 ${pendingCount} 个任务送入队列`);
        } else {
            req.log.info(`[Submit] 信任源导入: 直接入库 ${jsonData.files.length} 个文件`);
        }

        return { success: true, pendingCount };
    } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ success: false, error: e.message });
    }
});

// --- 删除相关 API ---
app.delete('/api/delete/series', async (req, reply) => {
    const id = parseInt(req.query.id);
    if (!id) return { error: "Missing ID" };
    await prisma.$transaction([
        prisma.seriesGenre.deleteMany({ where: { tmdbId: id } }),
        prisma.seriesEpisode.deleteMany({ where: { tmdbId: id } }),
        prisma.seriesMain.delete({ where: { tmdbId: id } })
    ]);
    req.log.info(`[Delete] 删除了剧集: TMDB ID ${id}`);
    return { success: true, id };
});

app.delete('/api/delete/episode', async (req, reply) => {
    const id = parseInt(req.query.id);
    if (!id || isNaN(id)) return { error: "Missing Row ID" };
    await prisma.seriesEpisode.delete({ where: { id } });
    req.log.info(`[Delete] 删除了单集文件: Row ID ${id}`);
    return { success: true, id };
});

// --- Webhook 自动上传 ---
app.post('/api/webhook/upload', async (req, reply) => {
    const { secret, file_name, path, etag, size } = req.body;
    if (secret !== CALLBACK_SECRET) return reply.code(403).send({ error: 'Invalid Secret' });
    if (!file_name || !etag) return { status: 'error', message: 'Missing fields' };

    const tmdbMatch = file_name.match(RE_TMDB_TAG) || path.match(RE_TMDB_TAG);
    if (!tmdbMatch) return { status: 'error', message: 'Missing {tmdb=xxx} tag' };
    const tmdbId = parseInt(tmdbMatch[1]);

    req.log.info(`[Webhook] 收到上传: ${file_name} (TMDB: ${tmdbId})`);

    const { season, episode } = parseSeasonEpisode(file_name, path.includes('Season') || path.includes('剧集') ? 'tv' : 'movie');
    const mediaType = (season > 0 || episode > 0) ? 'tv' : 'movie';
    const nowTime = new Date();
    
    // 确保 SeriesMain 存在
    let series = await prisma.seriesMain.findUnique({ where: { tmdbId } });
    if (!series) {
        const meta = await fetchTmdbMeta(tmdbId, mediaType);
        const name = meta ? (meta.name || meta.title) : file_name.split('.')[0];
        const year = meta ? (meta.first_air_date || meta.release_date || '').split('-')[0] : '';
        const genres = meta ? meta.genres.map(g => g.id).join(',') : '';

        series = await prisma.seriesMain.create({
            data: { tmdbId, name, year, type: mediaType, genres, lastUpdated: nowTime }
        });
        if (genres) {
            const genreList = genres.split(',').map(g => parseInt(g));
            for (const gid of genreList) {
                await prisma.$executeRaw`INSERT OR IGNORE INTO series_genres (tmdb_id, genre_id, type) VALUES (${tmdbId}, ${gid}, ${mediaType})`;
                if(year) await prisma.$executeRaw`INSERT OR IGNORE INTO stats_genre_years (genre_id, type, year) VALUES (${gid}, ${mediaType}, ${year})`;
            }
        }
    } else {
        await prisma.seriesMain.update({ where: { tmdbId }, data: { lastUpdated: nowTime } });
    }

    // 计算文件名与分数
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
            req.log.info(`[Webhook] 跳过低分文件: ${file_name} (${newScore} vs ${currentEp.score})`);
            return { status: 'skipped', reason: 'lower_score' };
        }
    }

    // 入库
    await prisma.$transaction(async (tx) => {
        if (!isSubtitle) {
             await tx.seriesEpisode.deleteMany({ where: { tmdbId, season, episode, type: { not: 'subtitle' } } });
        }
        await tx.seriesEpisode.create({
            data: {
                tmdbId, season, episode, cleanName: standardizedName,
                etag, size: BigInt(size), score: newScore,
                type: isSubtitle ? 'subtitle' : 'video', createdAt: nowTime
            }
        });
        
        // 更新目录时间
        const keys = [`root:${mediaType}`];
        if (series.genres) {
            const glist = series.genres.split(',');
            for (const g of glist) {
                keys.push(`genre:${mediaType}:${g}`);
                if (series.year) keys.push(`year:${mediaType}:${g}:${series.year}`);
            }
        }
        for (const k of keys) {
            await tx.$executeRaw`
                INSERT INTO folder_meta (key, last_updated) VALUES (${k}, ${nowTime.toISOString()})
                ON CONFLICT(key) DO UPDATE SET last_updated = excluded.last_updated
            `;
        }
    });

    // 依然进入 Queue 进行一次 Verify Rapid (确保 123 盘内有此文件)
    // 但 Webhook 来源不需要标记 QUEUED，因为它不经过前端审核
    await addToQueue({
        id: -1, cleanName: standardizedName, type: 'verify_rapid',
        etag, size, tmdbId, season, episode, score: newScore, sourceType: 'webhook'
    });

    req.log.info(`[Webhook] 处理完成: ${standardizedName}`);
    return { status: 'ok', new_name: standardizedName };
});

// --- Stream 接口 ---
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

// --- 离线下载回调 ---
app.post('/api/callback/123', async (req, reply) => {
    const { id, key } = req.query;
    if (key !== CALLBACK_SECRET) return reply.code(403).send("Forbidden");
    const body = req.body;
    
    req.log.info(`[Callback] 收到离线下载回调: ID ${id}, Status: ${body.status}`);
    
    await prisma.pendingEpisode.update({
        where: { id: parseInt(id) },
        data: { taskId: body.status === 0 ? 'DONE' : undefined }
    });
    return { code: 0 };
});

// 定时任务
setInterval(() => { core123.rotateDailyCache().catch(console.error); }, 24 * 60 * 60 * 1000);

// 辅助: 获取 TMDB 元数据
async function fetchTmdbMeta(id, type) {
    if (!TMDB_API_KEY) return null;
    const cacheKey = `tmdb:${type}:${id}`;
    if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);
    try {
        const res = await fetch(`https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API_KEY}&language=zh-CN`);
        if (res.ok) {
            const data = await res.json();
            metaCache.set(cacheKey, data);
            return data;
        }
    } catch (e) { console.error(e); }
    return null;
}

// 辅助: 解析季集
function parseSeasonEpisode(name, type) {
    const match = name.match(RE_SEASON_EPISODE);
    if (match) return { season: parseInt(match[1]), episode: parseInt(match[2]) };
    return type === 'movie' ? { season: 0, episode: 0 } : { season: 1, episode: 1 };
}

// 启动服务
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