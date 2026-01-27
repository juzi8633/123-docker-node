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

// ==========================================
// 1. 配置区域
// ==========================================
const WEBDAV_USER = process.env.WEBDAV_USER || "admin";
const WEBDAV_PASSWORD = process.env.WEBDAV_PASSWORD || "password";

// [默认基准时间] 当分类为空或查不到时间时使用
const DEFAULT_DATE = new Date('2023-01-01T00:00:00Z');

// ==========================================
// 2. 缓存策略
// ==========================================
const PREFIX_META = 'webdav:meta:'; // L1: 寻址缓存 (URL -> File Meta)
const PREFIX_LINK = 'webdav:link:'; // L2: 资源缓存 (ETag -> 123 Link)

const TTL_REDIS_META = 3600;    // 元数据缓存 1 小时
const TTL_LINK = 3600 * 24 * 3;      // 直链缓存 24 * 3 小时

// [L1 内存缓存]: 拦截毫秒级并发 (5秒过期)
// 仅用于缓存元数据对象，减少 Redis/DB 击穿
const lruCache = new LRUCache({ max: 1000, ttl: 1000 * 5 });

// ==========================================
// 3. 辅助函数
// ==========================================

function sanitizeName(name) {
    if (!name) return "Unknown";
    return String(name).replace(/\//g, '／').replace(/\\/g, '＼');
}

function calculateETag(str) {
    return '"' + crypto.createHash('md5').update(str).digest('hex') + '"';
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

// [精准时间] 获取分类下最新更新时间 (聚合查询)
async function getCategoryLastMod(condition) {
    try {
        const agg = await prisma.seriesMain.aggregate({
            where: condition,
            _max: { lastUpdated: true }
        });
        return agg._max.lastUpdated || DEFAULT_DATE;
    } catch (e) {
        return DEFAULT_DATE;
    }
}

/**
 * 生成单条 WebDAV XML 片段
 */
function genPropXML(href, displayName, isCollection, size, lastMod, creationDate, etag = "") {
    const modObj = lastMod ? new Date(lastMod) : DEFAULT_DATE;
    const createObj = creationDate ? new Date(creationDate) : modObj;

    const safeHref = escapeXml(href); 
    
    // 目录修正
    if (isCollection && !safeHref.endsWith('/')) { 
       // 虽然标准没强制，但部分客户端需要
    }

    const resourceType = isCollection ? "<D:collection/>" : "";
    const contentLength = isCollection ? "" : `<D:getcontentlength>${Number(size || 0)}</D:getcontentlength>`;
    const contentType = isCollection ? "" : `<D:getcontenttype>${getMimeType(displayName)}</D:getcontenttype>`;
    const etagNode = etag ? `<D:getetag>"${etag}"</D:getetag>` : "";
    const fileAttributes = isCollection ? "10" : "20";

    return `<D:response><D:href>${safeHref}</D:href><D:propstat><D:prop><D:displayname>${escapeXml(displayName)}</D:displayname><D:resourcetype>${resourceType}</D:resourcetype><D:creationdate>${createObj.toISOString()}</D:creationdate><D:getlastmodified>${toRFC1123(modObj)}</D:getlastmodified>${contentLength}${contentType}${etagNode}<D:Win32FileAttributes>${fileAttributes}</D:Win32FileAttributes></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

// [预热缓存] 在列出目录时顺便把文件元数据塞入 Redis
function pipelineCacheMeta(pipeline, f, tmdbId) {
    const key = `${PREFIX_META}${tmdbId}:${f.cleanName}`;
    const data = { cleanName: f.cleanName, etag: f.etag, size: String(f.size), createdAt: f.createdAt };
    pipeline.set(key, JSON.stringify(data), 'EX', TTL_REDIS_META);
}

// ==========================================
// 4. 分类配置
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
// 5. XML 流式生成器 (内存优化核心)
// ==========================================
async function* xmlStreamGenerator(pathStr, parts, depth, req, folderLastMod) {
    // 1. 输出头部
    yield `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">`;

    // 路径编码处理
    const encodedPathStr = parts.map(p => encodeURIComponent(p)).join('/');
    const basePathForXml = `/webdav${encodedPathStr ? '/' + encodedPathStr : ''}`;
    const selfName = parts.length > 0 ? decodeURIComponent(parts[parts.length - 1]) : '/';

    // 2. 输出 Self 节点
    yield genPropXML(basePathForXml, selfName, true, 0, folderLastMod, folderLastMod);

    if (depth !== '0') {
        // === [Level 0] 根目录 ===
        if (parts.length === 0) {
            const [recentEp, movieTime, tvTime] = await Promise.all([
                prisma.seriesEpisode.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
                getCategoryLastMod({ type: 'movie' }),
                getCategoryLastMod({ type: 'tv' })
            ]);
            const recentTime = recentEp?.createdAt || DEFAULT_DATE;

            yield genPropXML(`${basePathForXml}/最近更新`, '最近更新', true, 0, recentTime, recentTime);
            yield genPropXML(`${basePathForXml}/电影`, '电影', true, 0, movieTime, movieTime);
            yield genPropXML(`${basePathForXml}/电视剧`, '电视剧', true, 0, tvTime, tvTime);
        }
        
        // === [Level 1] 分类/最近更新 ===
        else if (parts.length === 1) {
            const folderName = parts[0]; 
            
            if (folderName === '最近更新') {
                const recentEpisodes = await prisma.seriesEpisode.groupBy({
                    by: ['tmdbId'],
                    _max: { createdAt: true },
                    orderBy: { _max: { createdAt: 'desc' } },
                    take: 50
                });
                const recentMeta = await prisma.seriesMain.findMany({
                    orderBy: { lastUpdated: 'desc' },
                    take: 50,
                    select: { tmdbId: true, lastUpdated: true }
                });

                const mixedIds = new Set([
                    ...recentEpisodes.map(e => e.tmdbId),
                    ...recentMeta.map(m => m.tmdbId)
                ]);

                if (mixedIds.size > 0) {
                    const seriesList = await prisma.seriesMain.findMany({
                        where: { tmdbId: { in: Array.from(mixedIds) } },
                        select: { tmdbId: true, name: true, year: true, lastUpdated: true },
                        orderBy: { lastUpdated: 'desc' },
                        take: 50
                    });

                    for (const s of seriesList) {
                        const safeNameStr = sanitizeName(s.name);
                        const rowName = `${safeNameStr} (${s.year || 'Unknown'}) {tmdb-${s.tmdbId}}`;
                        const href = `${basePathForXml}/${encodeURIComponent(rowName)}`;
                        yield genPropXML(href, rowName, true, 0, s.lastUpdated, getYearDate(s.year));
                    }
                }
            } else {
                const isMovie = folderName === '电影';
                for (const [catName, condition] of Object.entries(CATEGORY_MAP)) {
                    const isTarget = (isMovie && condition.type === 'movie') || (!isMovie && condition.type === 'tv');
                    if (isTarget) {
                        const catTime = await getCategoryLastMod(condition);
                        const href = `${basePathForXml}/${encodeURIComponent(catName)}`;
                        yield genPropXML(href, catName, true, 0, catTime, catTime);
                    }
                }
            }
        }
        
        // === [Level 2] 具体分类浏览 ===
        else if (parts.length === 2 && parts[0] !== '最近更新') {
            const [typeFolder, category] = parts;
            const condition = CATEGORY_MAP[category];
            
            if (condition) {
                let skip = 0;
                const BATCH_SIZE = 1000;
                let hasMore = true;

                while (hasMore) {
                    try {
                        const batch = await prisma.seriesMain.findMany({
                            where: condition,
                            select: { tmdbId: true, name: true, year: true, lastUpdated: true },
                            orderBy: { lastUpdated: 'desc' },
                            take: BATCH_SIZE,
                            skip: skip
                        });

                        if (batch.length < BATCH_SIZE) { hasMore = false; }
                        skip += BATCH_SIZE;

                        for (const s of batch) {
                            const safeNameStr = sanitizeName(s.name);
                            const rowName = `${safeNameStr} (${s.year || 'Unknown'}) {tmdb-${s.tmdbId}}`;
                            const href = `${basePathForXml}/${encodeURIComponent(rowName)}`;
                            yield genPropXML(href, rowName, true, 0, s.lastUpdated, getYearDate(s.year));
                        }
                        await new Promise(r => setImmediate(r));
                    } catch (err) {
                        console.error(`[WebDAV] Error in category stream ${category}:`, err);
                        hasMore = false; 
                    }
                }
            }
        }
        
        // === [Level 3/4] 详情页 ===
        else if (parts.length > 0) {
            const lastPart = parts[parts.length - 1];
            const prevPart = parts.length >= 2 ? parts[parts.length - 2] : null;
            
            const tmdbIdMatch = lastPart ? lastPart.match(/\{tmdb-(\d+)\}/) : null;
            const seasonMatch = lastPart ? lastPart.match(/Season (\d+)/) : null;
            const parentIdMatch = prevPart ? prevPart.match(/\{tmdb-(\d+)\}/) : null;

            // [A] 剧集根目录
            if (tmdbIdMatch && !seasonMatch) {
                const tmdbId = parseInt(tmdbIdMatch[1]);
                const seriesInfo = await prisma.seriesMain.findUnique({ where: { tmdbId }, select: { type: true } });

                if (seriesInfo?.type === 'movie') {
                    const files = await prisma.seriesEpisode.findMany({ 
                        where: { tmdbId, type: { not: 'subtitle' } },
                        select: { cleanName: true, size: true, createdAt: true, etag: true }
                    });
                    
                    const pipeline = redis.pipeline();
                    for (const f of files) {
                        const href = `${basePathForXml}/${encodeURIComponent(f.cleanName)}`;
                        yield genPropXML(href, f.cleanName, false, f.size, f.createdAt, f.createdAt, f.etag);
                        pipelineCacheMeta(pipeline, f, tmdbId);
                    }
                    pipeline.exec().catch(() => {});

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
                        const creation = s._min.createdAt || lastMod;
                        const href = `${basePathForXml}/${encodeURIComponent(seasonName)}`;
                        yield genPropXML(href, seasonName, true, s._sum.size, lastMod, creation);
                    }
                }
            }
            
            // [B] 季目录
            else if (parentIdMatch && seasonMatch) {
                const tmdbId = parseInt(parentIdMatch[1]);
                const season = parseInt(seasonMatch[1]);

                const files = await prisma.seriesEpisode.findMany({
                    where: { tmdbId, season, type: { not: 'subtitle' } }, 
                    select: { cleanName: true, size: true, createdAt: true, etag: true },
                    orderBy: { episode: 'asc' }
                });

                const pipeline = redis.pipeline();
                for (const f of files) {
                    const href = `${basePathForXml}/${encodeURIComponent(f.cleanName)}`;
                    yield genPropXML(href, f.cleanName, false, f.size, f.createdAt, f.createdAt, f.etag);
                    pipelineCacheMeta(pipeline, f, tmdbId);
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
        reply.header('WWW-Authenticate', 'Basic realm="123NodeServer"');
        return reply.code(401).send('Unauthorized');
    }
    const [scheme, encoded] = auth.split(' ');
    if (!/^Basic$/i.test(scheme) || !encoded) return reply.code(400).send('Bad Request');
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user !== WEBDAV_USER || pass !== WEBDAV_PASSWORD) return reply.code(403).send('Forbidden');

    let urlPath = decodeURIComponent(req.raw.url.replace(/^\/webdav/, '').split('?')[0]);
    if (urlPath.length > 1 && urlPath.endsWith('/')) urlPath = urlPath.slice(0, -1);
    
    const parts = urlPath.split('/').filter(p => p);
    const method = req.method.toUpperCase();

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
            default: return reply.code(405).send('Method Not Allowed');
        }
    } catch (e) {
        req.log.error(e, `[WebDAV] Error handling ${urlPath}`);
        return reply.code(500).send('Internal Server Error');
    }
}

// ==========================================
// 7. PROPFIND 处理器
// ==========================================
async function handlePropfind(req, reply, pathStr, parts) {
    const depth = req.headers['depth'] || '1';
    let folderLastMod = DEFAULT_DATE;

    try {
        if (parts.length === 0) {
             const [recentEp, movieTime, tvTime] = await Promise.all([
                prisma.seriesEpisode.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
                getCategoryLastMod({ type: 'movie' }),
                getCategoryLastMod({ type: 'tv' })
             ]);
             const recentTime = recentEp?.createdAt || DEFAULT_DATE;
             const maxTime = Math.max(recentTime.getTime(), movieTime.getTime(), tvTime.getTime());
             folderLastMod = new Date(maxTime);

        } else if (parts.length === 1 && parts[0] === '最近更新') {
             const recentEp = await prisma.seriesEpisode.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
             folderLastMod = recentEp?.createdAt || DEFAULT_DATE;

        } else if (parts.length === 2 && parts[0] !== '最近更新') {
             const condition = CATEGORY_MAP[parts[1]];
             if (condition) folderLastMod = await getCategoryLastMod(condition);
        } else {
             folderLastMod = new Date();
        }
    } catch(e) {
        console.warn('[WebDAV] Time calc failed, using default', e);
    }

    const pathHash = crypto.createHash('md5').update(pathStr).digest('hex');
    const etagStr = `W/"${pathHash}-${folderLastMod.getTime()}"`;
    
    reply.header('ETag', etagStr);
    if (req.headers['if-none-match'] === etagStr) {
        return reply.code(304).send();
    }

    reply.raw.setHeader('Content-Type', 'application/xml; charset=utf-8');
    reply.raw.setHeader('DAV', '1, 2');
    reply.raw.statusCode = 207;

    const xmlStream = Readable.from(xmlStreamGenerator(pathStr, parts, depth, req, folderLastMod));
    return reply.send(xmlStream);
}

// ==========================================
// 8. GET/HEAD 处理器 (核心优化：智能匹配 + 直链缓存)
// ==========================================
async function handleGet(req, reply, pathStr, parts) {
    const fileName = decodeURIComponent(parts[parts.length - 1]);
    let tmdbId = null;
    for(const part of parts) {
        const match = part.match(/\{tmdb-(\d+)\}/);
        if(match) { tmdbId = parseInt(match[1]); break; }
    }

    if (!tmdbId) return reply.code(403).send('Directory listing not allowed via GET');

    const extMatch = fileName.match(/\.(\w+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    const isVideo = ['mp4', 'mkv', 'avi', 'mov', 'strm'].includes(ext);

    let file = null;
    const cacheKeyMeta = `${PREFIX_META}${tmdbId}:${fileName}`;

    // [Step 1] 视频文件优先走智能匹配 (Smart Match)
    if (isVideo) {
        file = lruCache.get(cacheKeyMeta);
        
        if (!file) {
            const seMatch = fileName.match(RE_SEASON_EPISODE); // S01E01
            
            if (seMatch) {
                // 剧集：按 S/E 查找 (无视文件名后缀)
                const season = parseInt(seMatch[1]);
                const episode = parseInt(seMatch[2]);
                file = await prisma.seriesEpisode.findFirst({
                    where: { tmdbId, season, episode, type: { not: 'subtitle' } },
                    select: { cleanName: true, etag: true, size: true, createdAt: true }
                });
            } else {
                // 电影：按体积最大查找 (无视文件名后缀)
                file = await prisma.seriesEpisode.findFirst({
                    where: { tmdbId, type: { not: 'subtitle' } },
                    orderBy: { size: 'desc' },
                    select: { cleanName: true, etag: true, size: true, createdAt: true }
                });
            }
        }
    }

    // [Step 2] 兜底精确匹配 (字幕、图片、或智能匹配没找到的视频)
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

    if (!file) return reply.code(404).send('File not found');

    // [回写缓存] 建立 "请求文件名 -> 真实文件" 的映射
    if (isVideo && !lruCache.has(cacheKeyMeta)) {
         const cacheData = { ...file, size: String(file.size) };
         await redis.set(cacheKeyMeta, JSON.stringify(cacheData), 'EX', TTL_REDIS_META);
         lruCache.set(cacheKeyMeta, file);
    }

    // [MIME修正] 使用真实文件的扩展名来决定 Content-Type，而非 URL 请求的扩展名
    // 这样避免 "请求mp4，返回mkv流" 导致的某些客户端解析错误
    const headers = {
        'Content-Type': getMimeType(file.cleanName), // <--- 修正点
        'Content-Length': String(file.size),
        'Last-Modified': new Date(file.createdAt).toUTCString(),
        'ETag': `"${file.etag}"`,
        'Accept-Ranges': 'bytes'
    };

    if (req.method === 'HEAD') { reply.headers(headers); return reply.send(); }

    // [Step 3] 直链三级缓存
    const linkCacheKey = `${PREFIX_LINK}${file.etag}`;
    let downloadUrl = await redis.get(linkCacheKey);
    let isHit = false;

    if (downloadUrl) {
        isHit = true; 
    } else {
        try {
            downloadUrl = await core123.getDownloadUrlByHash(file.cleanName, file.etag, Number(file.size));
            if (downloadUrl) {
                await redis.set(linkCacheKey, downloadUrl, 'EX', TTL_LINK);
            } else {
                throw new Error('Link generation failed');
            }
        } catch (e) {
            req.log.error(e, `[WebDAV] Link Error: ${fileName}`);
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
// 10. 缓存清理接口
// ==========================================
export async function invalidateWebdavCache() {
    try {
        lruCache.clear();
        const stream = redis.scanStream({ match: `${PREFIX_META}*`, count: 100 });
        stream.on('data', (keys) => { if (keys.length) redis.unlink(keys); });
    } catch (e) { console.error('[WebDAV] Cache clear failed', e); }
}

export async function invalidateCacheByTmdbId(tmdbId) {
    if (!tmdbId) return;
    try {
        lruCache.clear();
        const tmdbStr = String(tmdbId);
        const metaStream = redis.scanStream({ match: `${PREFIX_META}${tmdbStr}:*`, count: 100 });
        metaStream.on('data', (keys) => { if (keys.length) redis.unlink(keys); });
    } catch (e) { console.error('[WebDAV] Invalidate error:', e); }
}