// src/webdav.js
import { prisma } from './db.js';
import { core123 } from './services/core123.js';
import redis from './redis.js';
import path from 'path';
import crypto from 'crypto';
import { LRUCache } from 'lru-cache';
import { Readable } from 'stream';
// 引入正则工具
import { RE_SEASON_EPISODE } from './utils.js';
// 引入项目统一日志模块
import { createLogger } from './logger.js';

// 初始化 WebDAV 专用 Logger
const logger = createLogger('WebDAV');

// ==========================================
// 1. 配置区域
// ==========================================
const WEBDAV_USER = process.env.WEBDAV_USER || "admin";
const WEBDAV_PASSWORD = process.env.WEBDAV_PASSWORD || "password";

// [默认基准时间] 当分类为空或查不到时间时使用 (2023-01-01)
const DEFAULT_DATE = new Date('2023-01-01T00:00:00Z');

// ==========================================
// 2. 缓存策略
// ==========================================
const PREFIX_META = 'webdav:meta:';    // L1: 文件元数据缓存 (URL -> File Meta)
const PREFIX_LINK = 'webdav:link:';    // L2: 下载直链缓存 (ETag -> 123 Link)
const PREFIX_LIST = 'webdav:list:';    // L3: 目录列表 XML 数据缓存 (PathHash -> JSON List)
const PREFIX_LASTMOD = 'webdav:lmod:'; // L4: 目录最后更新时间缓存 (PathHash -> Timestamp)

const TTL_REDIS_META = 3600;           // 元数据缓存 1 小时 (用于 GET 快速响应)
const TTL_LINK = 3600 * 24 * 3;        // 直链缓存 3 天
const TTL_LIST = 3600 * 24 * 30;       // 列表缓存 30 天 (写时失效)
const TTL_LASTMOD = 3600;              // LastMod 缓存 1 小时 (作为安全网，防止缓存不一致死锁)

// [L1 内存缓存]: 拦截毫秒级并发 (5秒过期)
const lruCache = new LRUCache({ max: 1000, ttl: 1000 * 5 });

// ==========================================
// 3. 分类配置
// ==========================================
const CATEGORY_MAP = {
    '华语电影': { type: 'movie', OR: [{ originalLanguage: 'zh' }, { originalLanguage: 'cn' }], NOT: { genres: { contains: '16' } } },
    '外语电影': { type: 'movie', NOT: [{ originalLanguage: 'zh' }, { originalLanguage: 'cn' }, { genres: { contains: '16' } }] },
    '动画电影': { type: 'movie', genres: { contains: '16' } },
    '国产剧': { type: 'tv', OR: [{ originalLanguage: 'zh' }, { originalLanguage: 'cn' }], NOT: { genres: { contains: '16' } } },
    '欧美剧': { type: 'tv', originalLanguage: 'en', NOT: { genres: { contains: '16' } } },
    '日韩剧': { type: 'tv', OR: [{ originalLanguage: 'ja' }, { originalLanguage: 'ko' }], NOT: { genres: { contains: '16' } } },
    '国漫':   { type: 'tv', genres: { contains: '16' }, originCountry: { contains: 'CN' } },
    '日番':   { type: 'tv', genres: { contains: '16' }, originCountry: { contains: 'JP' } },
    '纪录片': { type: 'tv', genres: { contains: '99' } },
    '综艺':   { type: 'tv', genres: { contains: '10764' } },
    '儿童':   { type: 'tv', genres: { contains: '10762' } },
    '其他剧集': { 
        type: 'tv', 
        NOT: [
            { originalLanguage: 'zh' }, { originalLanguage: 'cn' }, { originalLanguage: 'en' },
            { originalLanguage: 'ja' }, { originalLanguage: 'ko' },
            { genres: { contains: '16' } }, { genres: { contains: '99' } }, 
            { genres: { contains: '10764' } }, { genres: { contains: '10762' } }
        ]
    }
};

// ==========================================
// 4. 辅助函数
// ==========================================

function sanitizeName(name) {
    if (!name) return "Unknown";
    return String(name).replace(/\//g, '／').replace(/\\/g, '＼');
}

function escapeXml(unsafe) {
    if (!unsafe) return "";
    return String(unsafe).replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case "<": return "&lt;"; case ">": return "&gt;"; case "&": return "&amp;"; case "'": return "&apos;"; case '"': return "&quot;";
        }
    });
}

function toRFC1123(date) {
    return date.toUTCString();
}

function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const map = {
        '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg', '.png': 'image/png',
        '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.strm': 'application/vnd.apple.mpegurl',
        '.srt': 'text/plain', '.ass': 'text/plain', '.vtt': 'text/vtt', '.nfo': 'text/xml'
    };
    return map[ext] || 'application/octet-stream';
}

function getYearDate(yearStr) {
    if (!yearStr) return DEFAULT_DATE;
    const y = parseInt(yearStr);
    if (isNaN(y)) return DEFAULT_DATE;
    return new Date(`${y}-01-01T00:00:00Z`);
}

/**
 * [核心] 通用目录时间获取函数
 * 优先查 Redis，查不到则执行 queryFn 聚合查询
 */
async function getFolderLastMod(cacheKeySuffix, queryFn) {
    const cacheKey = `${PREFIX_LASTMOD}${cacheKeySuffix}`;
    const cached = await redis.get(cacheKey);
    if (cached) return new Date(cached);

    try {
        const date = await queryFn();
        // 如果查不到时间，使用 DEFAULT_DATE，确保不会因为 null 导致报错或时间变动
        const validDate = date || DEFAULT_DATE;
        await redis.set(cacheKey, validDate.toISOString(), 'EX', TTL_LASTMOD);
        return validDate;
    } catch (e) {
        logger.warn({ cacheKey, error: e.message }, `[警告] 获取目录时间失败`);
        return DEFAULT_DATE;
    }
}

/**
 * [核心] 提取剧集时间的独立函数 (用于 Level 3/4)
 */
async function getSeriesLastMod(namePart) {
    const match = namePart.match(/\{tmdb-(\d+)\}/);
    if (!match) return DEFAULT_DATE;
    
    const tmdbId = parseInt(match[1]);
    return await getFolderLastMod(`tmdb:${tmdbId}`, async () => {
        // 1. 优先取 SeriesMain 的 lastUpdated (刮削器更新时间)
        const series = await prisma.seriesMain.findUnique({ 
            where: { tmdbId }, 
            select: { lastUpdated: true } 
        });
        if (series?.lastUpdated) return series.lastUpdated;
        
        // 2. 兜底取最新一集添加时间
        const ep = await prisma.seriesEpisode.findFirst({
            where: { tmdbId },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true }
        });
        return ep?.createdAt;
    });
}

function genPropXML(href, displayName, isCollection, size, lastMod, creationDate, etag = "") {
    const modObj = lastMod ? new Date(lastMod) : DEFAULT_DATE;
    const createObj = creationDate ? new Date(creationDate) : modObj;

    const safeHref = escapeXml(href); 

    const resourceType = isCollection ? "<D:collection/>" : "";
    const contentLength = isCollection ? "" : `<D:getcontentlength>${Number(size || 0)}</D:getcontentlength>`;
    const contentType = isCollection ? "" : `<D:getcontenttype>${getMimeType(displayName)}</D:getcontenttype>`;
    const etagNode = etag ? `<D:getetag>"${etag}"</D:getetag>` : "";
    const fileAttributes = isCollection ? "10" : "20";

    return `<D:response><D:href>${safeHref}</D:href><D:propstat><D:prop><D:displayname>${escapeXml(displayName)}</D:displayname><D:resourcetype>${resourceType}</D:resourcetype><D:creationdate>${createObj.toISOString()}</D:creationdate><D:getlastmodified>${toRFC1123(modObj)}</D:getlastmodified>${contentLength}${contentType}${etagNode}<D:Win32FileAttributes>${fileAttributes}</D:Win32FileAttributes></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function pipelineCacheMeta(pipeline, f, tmdbId) {
    const key = `${PREFIX_META}${tmdbId}:${f.cleanName}`;
    const data = { cleanName: f.cleanName, etag: f.etag, size: String(f.size), createdAt: f.createdAt };
    pipeline.set(key, JSON.stringify(data), 'EX', TTL_REDIS_META);
}

// ==========================================
// 5. XML 流式生成器 (Scheme B: 强制年份折叠)
// ==========================================
async function* xmlStreamGenerator(pathStr, parts, depth, req, folderLastMod) {
    yield `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">`;

    const encodedPathStr = parts.map(p => encodeURIComponent(p)).join('/');
    const basePathForXml = `/webdav${encodedPathStr ? '/' + encodedPathStr : ''}`;
    const selfName = parts.length > 0 ? decodeURIComponent(parts[parts.length - 1]) : '/';

    yield genPropXML(basePathForXml, selfName, true, 0, folderLastMod, folderLastMod);

    if (depth !== '0') {
        const pathHash = crypto.createHash('md5').update(pathStr).digest('hex');
        const listCacheKey = `${PREFIX_LIST}${pathHash}`;

        // === [列表缓存检查] ===
        if (parts.length >= 2 || (parts.length === 1 && parts[0] !== '最近更新')) {
             const cachedData = await redis.get(listCacheKey);
             if (cachedData) {
                 // logger.info({ path: pathStr }, `[缓存命中]`);
                 const list = JSON.parse(cachedData);
                 for (const item of list) {
                     yield genPropXML(item.href, item.name, item.isCol, item.size||0, item.lastMod, item.lastMod, item.etag||"");
                 }
                 yield `</D:multistatus>`;
                 return;
             }
        }

        // logger.info({ path: pathStr }, `[缓存未命中] 生成实时数据`);

        // [Level 0] 根目录
        if (parts.length === 0) {
            const [recentTime, movieTime, tvTime] = await Promise.all([
                 getFolderLastMod('RECENT', async () => {
                     const ep = await prisma.seriesEpisode.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
                     return ep?.createdAt;
                 }),
                 getFolderLastMod('GLOBAL_MOVIE', async () => {
                     const agg = await prisma.seriesMain.aggregate({ where: { type: 'movie' }, _max: { lastUpdated: true } });
                     return agg._max.lastUpdated;
                 }),
                 getFolderLastMod('GLOBAL_TV', async () => {
                     const agg = await prisma.seriesMain.aggregate({ where: { type: 'tv' }, _max: { lastUpdated: true } });
                     return agg._max.lastUpdated;
                 })
            ]);

            yield genPropXML(`${basePathForXml}/最近更新`, '最近更新', true, 0, recentTime, recentTime);
            yield genPropXML(`${basePathForXml}/电影`, '电影', true, 0, movieTime, movieTime);
            yield genPropXML(`${basePathForXml}/电视剧`, '电视剧', true, 0, tvTime, tvTime);
        }
        
        // [Level 1] 分类/最近更新
        else if (parts.length === 1) {
            const folderName = parts[0]; 
            
            if (folderName === '最近更新') {
                const recentEpisodes = await prisma.seriesEpisode.groupBy({
                    by: ['tmdbId'], _max: { createdAt: true }, orderBy: { _max: { createdAt: 'desc' } }, take: 50
                });
                const recentMeta = await prisma.seriesMain.findMany({
                    orderBy: { lastUpdated: 'desc' }, take: 50, select: { tmdbId: true, lastUpdated: true }
                });

                const mixedIds = new Set([
                    ...recentEpisodes.map(e => e.tmdbId),
                    ...recentMeta.map(m => m.tmdbId)
                ]);

                if (mixedIds.size > 0) {
                    const seriesList = await prisma.seriesMain.findMany({
                        where: { tmdbId: { in: Array.from(mixedIds) } },
                        select: { tmdbId: true, name: true, year: true, lastUpdated: true },
                        orderBy: { lastUpdated: 'desc' }, take: 50
                    });

                    for (const s of seriesList) {
                        const safeNameStr = sanitizeName(s.name);
                        const rowName = `${safeNameStr} (${s.year || 'Unknown'}) {tmdb-${s.tmdbId}}`;
                        const href = `${basePathForXml}/${encodeURIComponent(rowName)}`;
                        yield genPropXML(href, rowName, true, 0, s.lastUpdated, getYearDate(s.year));
                    }
                }
            } else {
                // 处理“电影”、“电视剧”或“华语电影”等
                const isMovie = folderName === '电影';
                for (const [catName, condition] of Object.entries(CATEGORY_MAP)) {
                    const isTarget = (isMovie && condition.type === 'movie') || (!isMovie && condition.type === 'tv');
                    if (isTarget) {
                        const catTime = await getFolderLastMod(catName, async () => {
                             const agg = await prisma.seriesMain.aggregate({ where: condition, _max: { lastUpdated: true } });
                             return agg._max.lastUpdated;
                        });
                        const href = `${basePathForXml}/${encodeURIComponent(catName)}`;
                        yield genPropXML(href, catName, true, 0, catTime, catTime);
                    }
                }
            }
        }
        
        // [Level 2] 具体分类浏览 -> 强制年份折叠
        else if (parts.length === 2 && parts[0] !== '最近更新') {
            const [typeFolder, category] = parts;
            const condition = CATEGORY_MAP[category];
            
            if (condition) {
                const itemsToCache = [];

                // 无条件聚合年份，不再判断 count
                const groups = await prisma.seriesMain.groupBy({
                    by: ['year'],
                    where: condition,
                    _max: { lastUpdated: true },
                    orderBy: { year: 'desc' }
                });
                
                const yearFolders = [];
                let otherGroup = null;

                for (const g of groups) {
                    if (!g.year) {
                        if (!otherGroup) otherGroup = { year: '其他', lastMod: g._max.lastUpdated };
                        else if (g._max.lastUpdated > otherGroup.lastMod) otherGroup.lastMod = g._max.lastUpdated;
                    } else {
                        yearFolders.push({ year: g.year, lastMod: g._max.lastUpdated });
                    }
                }
                if (otherGroup) yearFolders.push(otherGroup);

                for (const yf of yearFolders) {
                    const rowName = yf.year;
                    const href = `${basePathForXml}/${encodeURIComponent(rowName)}`;
                    const lastModStr = yf.lastMod ? yf.lastMod.toISOString() : DEFAULT_DATE.toISOString();
                    
                    yield genPropXML(href, rowName, true, 0, yf.lastMod, yf.lastMod);
                    itemsToCache.push({ href, name: rowName, isCol: true, lastMod: lastModStr });
                }

                if (itemsToCache.length > 0) {
                    await redis.set(listCacheKey, JSON.stringify(itemsToCache), 'EX', TTL_LIST);
                }
            }
        }

        // [Level 3] 年份文件夹详情
        else if (parts.length === 3 && parts[1] !== '最近更新') {
            const [typeFolder, category, subNode] = parts;
            // 只有当 subNode 看起来像年份或'其他'时才处理
            const isYearNode = /^\d{4}$/.test(subNode) || subNode === '其他';
            
            if (isYearNode) {
                const condition = CATEGORY_MAP[category];
                if (condition) {
                    const yearCondition = subNode === '其他' 
                        ? { OR: [{ year: null }, { year: '' }] }
                        : { year: subNode };
                    
                    const seriesList = await prisma.seriesMain.findMany({
                        where: { ...condition, ...yearCondition },
                        select: { tmdbId: true, name: true, year: true, lastUpdated: true },
                        orderBy: { lastUpdated: 'desc' }
                    });

                    const itemsToCache = [];
                    for (const s of seriesList) {
                        const safeNameStr = sanitizeName(s.name);
                        const rowName = `${safeNameStr} (${s.year || 'Unknown'}) {tmdb-${s.tmdbId}}`;
                        const href = `${basePathForXml}/${encodeURIComponent(rowName)}`;
                        const lastModStr = s.lastUpdated ? s.lastUpdated.toISOString() : DEFAULT_DATE.toISOString();

                        yield genPropXML(href, rowName, true, 0, s.lastUpdated, getYearDate(s.year));
                        itemsToCache.push({ href, name: rowName, isCol: true, lastMod: lastModStr });
                    }
                    
                    if (itemsToCache.length > 0) {
                        await redis.set(listCacheKey, JSON.stringify(itemsToCache), 'EX', TTL_LIST);
                    }
                }
            }
        }
        
        // [Level 3/4] 剧集详情页 (包含文件或 Season 文件夹)
        if (parts.length > 0) {
            const lastPart = parts[parts.length - 1];
            const prevPart = parts.length >= 2 ? parts[parts.length - 2] : null;
            
            const tmdbIdMatch = lastPart ? lastPart.match(/\{tmdb-(\d+)\}/) : null;
            const seasonMatch = lastPart ? lastPart.match(/Season (\d+)/) : null;
            const parentIdMatch = prevPart ? prevPart.match(/\{tmdb-(\d+)\}/) : null;

            if (tmdbIdMatch && !seasonMatch) {
                const tmdbId = parseInt(tmdbIdMatch[1]);
                const seriesInfo = await prisma.seriesMain.findUnique({ where: { tmdbId }, select: { type: true } });

                const itemsToCache = [];
                const pipeline = redis.pipeline();

                if (seriesInfo?.type === 'movie') {
                    const files = await prisma.seriesEpisode.findMany({ 
                        where: { tmdbId, type: { not: 'subtitle' } },
                        select: { cleanName: true, size: true, createdAt: true, etag: true }
                    });
                    
                    for (const f of files) {
                        const href = `${basePathForXml}/${encodeURIComponent(f.cleanName)}`;
                        yield genPropXML(href, f.cleanName, false, f.size, f.createdAt, f.createdAt, f.etag);
                        pipelineCacheMeta(pipeline, f, tmdbId);
                        
                        itemsToCache.push({ 
                            href, name: f.cleanName, isCol: false, size: String(f.size), 
                            lastMod: f.createdAt.toISOString(), etag: f.etag 
                        });
                    }
                } else {
                    const seasonCounts = await prisma.seriesEpisode.groupBy({
                        by: ['season'], 
                        where: { tmdbId, type: { not: 'subtitle' } }, 
                        _max: { createdAt: true },
                        _min: { createdAt: true }, 
                        _sum: { size: true } 
                    });
                    seasonCounts.sort((a, b) => (a.season||0) - (b.season||0));
                    
                    for (const s of seasonCounts) {
                        const seasonName = `Season ${String(s.season).padStart(2, '0')}`;
                        const lastMod = s._max.createdAt || DEFAULT_DATE;
                        const href = `${basePathForXml}/${encodeURIComponent(seasonName)}`;
                        yield genPropXML(href, seasonName, true, s._sum.size, lastMod, s._min.createdAt);

                        itemsToCache.push({ 
                            href, name: seasonName, isCol: true, size: 0, lastMod: lastMod.toISOString() 
                        });
                    }
                }

                if (itemsToCache.length > 0) {
                    pipeline.set(listCacheKey, JSON.stringify(itemsToCache), 'EX', TTL_LIST);
                    const mappingKey = `dav:mapping:tmdb:${tmdbId}`;
                    pipeline.sadd(mappingKey, listCacheKey);
                    pipeline.expire(mappingKey, TTL_LIST); 
                }
                pipeline.exec().catch(() => {});
            }
            
            else if (parentIdMatch && seasonMatch) {
                const tmdbId = parseInt(parentIdMatch[1]);
                const season = parseInt(seasonMatch[1]);

                const files = await prisma.seriesEpisode.findMany({
                    where: { tmdbId, season, type: { not: 'subtitle' } }, 
                    select: { cleanName: true, size: true, createdAt: true, etag: true },
                    orderBy: { episode: 'asc' }
                });

                const itemsToCache = [];
                const pipeline = redis.pipeline();

                for (const f of files) {
                    const href = `${basePathForXml}/${encodeURIComponent(f.cleanName)}`;
                    yield genPropXML(href, f.cleanName, false, f.size, f.createdAt, f.createdAt, f.etag);
                    pipelineCacheMeta(pipeline, f, tmdbId);

                    itemsToCache.push({ 
                        href, name: f.cleanName, isCol: false, size: String(f.size), 
                        lastMod: f.createdAt.toISOString(), etag: f.etag 
                    });
                }
                
                if (itemsToCache.length > 0) {
                    pipeline.set(listCacheKey, JSON.stringify(itemsToCache), 'EX', TTL_LIST);
                    const mappingKey = `dav:mapping:tmdb:${tmdbId}`;
                    pipeline.sadd(mappingKey, listCacheKey);
                    pipeline.expire(mappingKey, TTL_LIST);
                }
                pipeline.exec().catch(() => {});
            }
        }
    }

    yield `</D:multistatus>`;
}

// ==========================================
// 6. 入口分发
// ==========================================
export async function handleWebDavRequest(req, reply) {
    const auth = req.headers['authorization'];
    if (!auth) {
        logger.warn(`[鉴权失败] 未提供认证头`);
        reply.header('WWW-Authenticate', 'Basic realm="123NodeServer"');
        return reply.code(401).send('Unauthorized');
    }
    const [scheme, encoded] = auth.split(' ');
    if (!/^Basic$/i.test(scheme) || !encoded) return reply.code(400).send('Bad Request');
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user !== WEBDAV_USER || pass !== WEBDAV_PASSWORD) {
        logger.warn({ user }, `[鉴权拒绝] 用户名或密码错误`);
        return reply.code(403).send('Forbidden');
    }

    let urlPath = decodeURIComponent(req.raw.url.replace(/^\/webdav/, '').split('?')[0]);
    if (urlPath.length > 1 && urlPath.endsWith('/')) urlPath = urlPath.slice(0, -1);
    
    const parts = urlPath.split('/').filter(p => p);
    const method = req.method.toUpperCase();

    logger.info({ method, path: urlPath }, `收到 WebDAV 请求`);

    try {
        switch (method) {
            case 'PROPFIND': return await handlePropfind(req, reply, urlPath, parts);
            case 'GET': return await handleGet(req, reply, urlPath, parts);
            case 'HEAD': return await handleGet(req, reply, urlPath, parts);
            case 'OPTIONS':
                reply.header('DAV', '1, 2');
                reply.header('Allow', 'OPTIONS, GET, HEAD, PROPFIND, PROPPATCH, LOCK, UNLOCK');
                reply.header('MS-Author-Via', 'DAV'); 
                return reply.send();
            case 'PROPPATCH': return handleDummyProppatch(reply, urlPath);
            case 'LOCK': return handleDummyLock(req, reply, urlPath);
            case 'UNLOCK': return reply.code(204).send();
            default: 
                // [优化] 对于不支持的写操作，直接 403，减少客户端报错
                if (['PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY'].includes(method)) {
                    logger.debug({ method, path: urlPath }, `[只读模式] 拦截写操作`);
                    return reply.code(403).send('Forbidden');
                }
                logger.warn({ method, path: urlPath }, `[警告] 未支持的方法`);
                return reply.code(405).send('Method Not Allowed');
        }
    } catch (e) {
        logger.error({ err: e, path: urlPath }, `[严重错误] 处理请求失败`);
        return reply.code(500).send('Internal Server Error');
    }
}

// ==========================================
// 7. PROPFIND 处理器 (支持 304)
// ==========================================
async function handlePropfind(req, reply, pathStr, parts) {
    const depth = req.headers['depth'] || '1';
    let folderLastMod = DEFAULT_DATE;

    try {
        // [Level 0] 根目录
        if (parts.length === 0) {
            folderLastMod = await getFolderLastMod('ROOT', async () => {
                const [recentEp, movieTime, tvTime] = await Promise.all([
                    prisma.seriesEpisode.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
                    prisma.seriesMain.aggregate({ where: { type: 'movie' }, _max: { lastUpdated: true } }),
                    prisma.seriesMain.aggregate({ where: { type: 'tv' }, _max: { lastUpdated: true } })
                ]);
                const t1 = recentEp?.createdAt?.getTime() || 0;
                const t2 = movieTime._max.lastUpdated?.getTime() || 0;
                const t3 = tvTime._max.lastUpdated?.getTime() || 0;
                return new Date(Math.max(t1, t2, t3));
            });

        } else if (parts.length === 1) {
            // [Level 1]
            const folderName = parts[0];
            if (folderName === '最近更新') {
                 folderLastMod = await getFolderLastMod('RECENT', async () => {
                     const ep = await prisma.seriesEpisode.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
                     return ep?.createdAt;
                 });
            } else {
                 const isMovie = folderName === '电影';
                 const isTv = folderName === '电视剧';
                 if (isMovie || isTv) {
                     const type = isMovie ? 'movie' : 'tv';
                     folderLastMod = await getFolderLastMod(`GLOBAL_${type.toUpperCase()}`, async () => {
                         const agg = await prisma.seriesMain.aggregate({ where: { type }, _max: { lastUpdated: true } });
                         return agg._max.lastUpdated;
                     });
                 } else {
                     const condition = CATEGORY_MAP[folderName];
                     if (condition) {
                         folderLastMod = await getFolderLastMod(folderName, async () => {
                             const agg = await prisma.seriesMain.aggregate({ where: condition, _max: { lastUpdated: true } });
                             return agg._max.lastUpdated;
                         });
                     }
                 }
            }
        } else if (parts.length === 2 && parts[0] !== '最近更新') {
             // [Level 2] 分类 -> (现在全是) 年份文件夹
             // 例如 /webdav/电影/华语电影 -> 这里的 folderLastMod 是 "华语电影" 这个目录本身的时间
             const categoryName = parts[1];
             const condition = CATEGORY_MAP[categoryName];
             if (condition) {
                 folderLastMod = await getFolderLastMod(categoryName, async () => {
                     const agg = await prisma.seriesMain.aggregate({ where: condition, _max: { lastUpdated: true } });
                     return agg._max.lastUpdated;
                 });
             }
        } else if (parts.length >= 3 && parts[1] !== '最近更新') {
             // [Level 3] 年份内部 / 剧集
             const categoryName = parts[1];
             const subNode = parts[2]; // 年份 或 '其他'
             const condition = CATEGORY_MAP[categoryName];
             
             if (condition) {
                 const isYear = /^\d{4}$/.test(subNode);
                 const isOther = subNode === '其他';
                 
                 if (isYear || isOther) {
                     // 访问的是年份目录本身，获取该年份下内容的最后更新时间
                     const yearVal = isYear ? subNode : null;
                     const yearCondition = isOther 
                         ? { OR: [{ year: null }, { year: '' }] }
                         : { year: yearVal };

                     folderLastMod = await getFolderLastMod(`${categoryName}:${subNode}`, async () => {
                         const agg = await prisma.seriesMain.aggregate({
                             where: { ...condition, ...yearCondition },
                             _max: { lastUpdated: true }
                         });
                         return agg._max.lastUpdated;
                     });
                 } else {
                     // 已经进入剧集或更深层
                     const time = await getSeriesLastMod(subNode);
                     if (time) folderLastMod = time;
                 }
             }
        }

        // 兜底：如果 URL 包含 tmdb id，尝试获取剧集时间
        if (parts.length > 0) {
            const lastPart = parts[parts.length - 1];
            if (lastPart.includes('{tmdb-')) {
                 const time = await getSeriesLastMod(lastPart);
                 if (time && time > DEFAULT_DATE) folderLastMod = time;
            }
        }

    } catch(e) {
        logger.warn({ err: e }, '计算文件夹时间失败，使用默认值');
    }

    const pathHash = crypto.createHash('md5').update(pathStr).digest('hex');
    const etagStr = `W/"${pathHash}-${folderLastMod.getTime()}"`;
    
    reply.header('ETag', etagStr);
    if (req.headers['if-none-match'] === etagStr) {
        logger.info({ path: pathStr }, `[304命中] 客户端缓存有效`);
        return reply.code(304).send();
    }

    reply.raw.setHeader('Content-Type', 'application/xml; charset=utf-8');
    reply.raw.setHeader('DAV', '1, 2');
    reply.raw.statusCode = 207;

    const xmlStream = Readable.from(xmlStreamGenerator(pathStr, parts, depth, req, folderLastMod));
    return reply.send(xmlStream);
}

// ==========================================
// 8. GET/HEAD 处理器
// ==========================================
async function handleGet(req, reply, pathStr, parts) {
    const fileName = decodeURIComponent(parts[parts.length - 1]);
    let tmdbId = null;
    // 强制扫描所有层级寻找 tmdbId，不受目录结构影响
    for(const part of parts) {
        const match = part.match(/\{tmdb-(\d+)\}/);
        if(match) { tmdbId = parseInt(match[1]); break; }
    }

    if (!tmdbId) {
        logger.warn({ path: pathStr }, `[禁止访问] GET 请求未携带 tmdbId`);
        return reply.code(403).send('Directory listing not allowed via GET');
    }

    const extMatch = fileName.match(/\.(\w+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    const isVideo = ['mp4', 'mkv', 'avi', 'mov', 'strm'].includes(ext);

    let file = null;
    const cacheKeyMeta = `${PREFIX_META}${tmdbId}:${fileName}`;

    // [Step 1] 视频文件优先走智能匹配 (Smart Match)
    if (isVideo) {
        file = lruCache.get(cacheKeyMeta);
        
        if (!file) {
            const seMatch = fileName.match(RE_SEASON_EPISODE); 
            
            if (seMatch) {
                const season = parseInt(seMatch[1]);
                const episode = parseInt(seMatch[2]);
                file = await prisma.seriesEpisode.findFirst({
                    where: { tmdbId, season, episode, type: { not: 'subtitle' } },
                    select: { cleanName: true, etag: true, size: true, createdAt: true }
                });
            } else {
                file = await prisma.seriesEpisode.findFirst({
                    where: { tmdbId, type: { not: 'subtitle' } },
                    orderBy: { size: 'desc' },
                    select: { cleanName: true, etag: true, size: true, createdAt: true }
                });
            }
        }
    }

    // [Step 2] 兜底精确匹配
    if (!file) {
        file = lruCache.get(cacheKeyMeta);
        if (!file) {
            const cachedMetaStr = await redis.get(cacheKeyMeta);
            if (cachedMetaStr) {
                file = JSON.parse(cachedMetaStr);
                file.createdAt = new Date(file.createdAt);
            } else {
                file = await prisma.seriesEpisode.findFirst({
                    where: { tmdbId, cleanName: fileName },
                    select: { cleanName: true, etag: true, size: true, createdAt: true }
                });
            }
        }
    }

    if (!file) {
        logger.warn({ fileName, tmdbId }, `[404] 文件在数据库中不存在`);
        return reply.code(404).send('File not found');
    }

    if (isVideo && !lruCache.has(cacheKeyMeta)) {
         const cacheData = { ...file, size: String(file.size) };
         await redis.set(cacheKeyMeta, JSON.stringify(cacheData), 'EX', TTL_REDIS_META);
         lruCache.set(cacheKeyMeta, file);
    }

    const headers = {
        'Content-Type': getMimeType(file.cleanName), 
        'Content-Length': String(file.size),
        'Last-Modified': new Date(file.createdAt).toUTCString(),
        'ETag': `"${file.etag}"`,
        'Accept-Ranges': 'bytes'
    };

    if (req.method === 'HEAD') { 
        reply.headers(headers); 
        return reply.code(200).send(); 
    }

    // [Step 3] 直链三级缓存
    const linkCacheKey = `${PREFIX_LINK}${file.etag}`;
    let downloadUrl = await redis.get(linkCacheKey);
    let isHit = false;

    if (downloadUrl) {
        isHit = true; 
        logger.info({ fileName, etag: file.etag }, `[直链缓存命中] 重定向播放`);
    } else {
        try {
            logger.info({ fileName }, `[直链缓存未命中] 正在获取新直链`);
            downloadUrl = await core123.getDownloadUrlByHash(file.cleanName, file.etag, Number(file.size));
            if (downloadUrl) {
                await redis.set(linkCacheKey, downloadUrl, 'EX', TTL_LINK);
            } else {
                throw new Error('123云盘未返回有效的下载地址');
            }
        } catch (e) {
            logger.error({ err: e, fileName }, `[获取直链失败]`);
            return reply.code(502).send('Upstream Error');
        }
    }

    reply.header('Cache-Control', `public, max-age=${TTL_LINK}`);
    reply.header('X-Drive-Cache', isHit ? 'HIT' : 'MISS');
    
    return reply.redirect(downloadUrl);
}

// ==========================================
// 9. 辅助处理器
// ==========================================

function handleDummyProppatch(reply, urlPath) {
    const xml = `<?xml version="1.0" encoding="utf-8" ?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${escapeXml(urlPath)}</D:href><D:propstat><D:prop><D:Win32CreationTime/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    return sendXml(reply, xml);
}

function handleDummyLock(req, reply, urlPath) {
    const token = `urn:uuid:${crypto.randomUUID()}`;
    const xml = `<?xml version="1.0" encoding="utf-8" ?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>Infinity</D:depth><D:owner><D:href>Unknown</D:href></D:owner><D:timeout>Second-604800</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`;
    reply.header('Lock-Token', `<${token}>`);
    return sendXml(reply, xml);
}

function sendXml(reply, xml) {
    return reply.type('application/xml; charset=utf-8').header('DAV', '1, 2').status(207).send(xml);
}

// ==========================================
// 10. 缓存清理接口 (全链路精准清除)
// ==========================================
export async function invalidateCacheByTmdbId(tmdbId) {
    if (!tmdbId) return;
    logger.info({ tmdbId }, `[主动缓存清理] 触发清理`);
    
    const tmdbIdInt = parseInt(tmdbId);
    try {
        const series = await prisma.seriesMain.findUnique({ where: { tmdbId: tmdbIdInt } });
        if (!series) {
            logger.warn({ tmdbId }, `[警告] 查无此剧，降级为全局清理`);
            return invalidateWebdavCache();
        }

        const pipelines = redis.pipeline();

        // 1. 清除根目录和入口分类时间戳 (Critical: 保证入口能刷新)
        pipelines.del(`${PREFIX_LASTMOD}ROOT`);
        pipelines.del(`${PREFIX_LASTMOD}RECENT`);
        const typeKey = series.type === 'movie' ? 'GLOBAL_MOVIE' : 'GLOBAL_TV';
        pipelines.del(`${PREFIX_LASTMOD}${typeKey}`);
        
        // 2. 清除详情页 (通过反向索引)
        const mappingKey = `dav:mapping:tmdb:${tmdbId}`;
        const relatedCacheKeys = await redis.smembers(mappingKey);
        
        if (relatedCacheKeys.length > 0) {
            pipelines.unlink(relatedCacheKeys);
            pipelines.unlink(mappingKey);
        }
        
        // 3. 清除该剧集的自身时间戳
        pipelines.del(`${PREFIX_LASTMOD}tmdb:${tmdbId}`);

        // 4. 清除分类列表逻辑 & 分类时间戳
        const targetCategories = [];
        for (const [catName, condition] of Object.entries(CATEGORY_MAP)) {
            let match = true;
            if (condition.type !== series.type) match = false;
            // 简单的条件匹配逻辑
            if (match && condition.OR) {
                const langMatch = condition.OR.some(c => c.originalLanguage === series.originalLanguage);
                if (!langMatch) match = false;
            } else if (match && condition.originalLanguage) {
                if (condition.originalLanguage !== series.originalLanguage) match = false;
            }
            if (match && condition.genres) {
                if (!series.genres || !series.genres.includes(condition.genres.contains)) match = false;
            }
            if (match && condition.originCountry) {
                if (!series.originCountry || !series.originCountry.includes(condition.originCountry.contains)) match = false;
            }
            if (match && condition.NOT) {
                 if (condition.NOT.genres && series.genres && series.genres.includes(condition.NOT.genres.contains)) match = false;
            }
            if (match) targetCategories.push(catName);
        }
        
        const isMovie = series.type === 'movie';
        const rootPath = isMovie ? '/webdav/电影' : '/webdav/电视剧';
        
        for (const cat of targetCategories) {
            const catPath = `${rootPath}/${cat}`;
            const catHash = crypto.createHash('md5').update(catPath).digest('hex');
            
            // (a) 清除分类列表缓存
            pipelines.del(`${PREFIX_LIST}${catHash}`);
            // (b) 清除分类时间戳
            pipelines.del(`${PREFIX_LASTMOD}${cat}`); 
            
            // (c) 清除年份相关的缓存 (因强制折叠，年份目录必存在)
            if (series.year) {
                const yearPath = `${catPath}/${series.year}`;
                const yearHash = crypto.createHash('md5').update(yearPath).digest('hex');
                pipelines.del(`${PREFIX_LIST}${yearHash}`);
                pipelines.del(`${PREFIX_LASTMOD}${cat}:${series.year}`);
            } else {
                const otherPath = `${catPath}/其他`;
                const otherHash = crypto.createHash('md5').update(otherPath).digest('hex');
                pipelines.del(`${PREFIX_LIST}${otherHash}`);
                pipelines.del(`${PREFIX_LASTMOD}${cat}:其他`);
            }
        }
        
        const recentPath = '/webdav/最近更新';
        const recentHash = crypto.createHash('md5').update(recentPath).digest('hex');
        pipelines.del(`${PREFIX_LIST}${recentHash}`);

        // 5. 清除元数据
        const tmdbStr = String(tmdbId);
        const metaStream = redis.scanStream({ match: `${PREFIX_META}${tmdbStr}:*`, count: 100 });
        metaStream.on('data', keys => { if (keys.length) redis.unlink(keys); });

        await pipelines.exec();
        logger.info(`[清理完成] 关联列表及时间戳已重置`);

    } catch (e) { 
        logger.error({ err: e, tmdbId }, `[严重] 缓存清理失败`);
    }
}

export async function invalidateWebdavCache() {
    logger.info(`[全局缓存清理] 开始重置所有列表`);
    try {
        lruCache.clear();
        const streamList = redis.scanStream({ match: `${PREFIX_LIST}*`, count: 100 });
        streamList.on('data', (keys) => { if (keys.length) redis.unlink(keys); });
        
        const streamMod = redis.scanStream({ match: `${PREFIX_LASTMOD}*`, count: 100 });
        streamMod.on('data', (keys) => { if (keys.length) redis.unlink(keys); });

        const streamMeta = redis.scanStream({ match: `${PREFIX_META}*`, count: 100 });
        streamMeta.on('data', (keys) => { if (keys.length) redis.unlink(keys); });
    } catch (e) { 
        logger.error({ err: e }, `[错误] 全局清理失败`);
    }
}