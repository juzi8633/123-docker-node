// src/webdav.js
import { prisma } from './db.js';
import { core123 } from './services/core123.js';
import redis from './redis.js';
import path from 'path';
import crypto from 'crypto';
import { LRUCache } from 'lru-cache';

// ==========================================
// 1. 配置区域
// ==========================================
const WEBDAV_USER = process.env.WEBDAV_USER || "admin";
const WEBDAV_PASSWORD = process.env.WEBDAV_PASSWORD || "password";

// [核心优化] 时间锚点：固定静态目录时间戳，防止客户端重复全量扫描
const STATIC_FOLDER_DATE = new Date('2023-01-01T00:00:00Z'); 

// ==========================================
// 2. 缓存策略
// ==========================================
const PREFIX_DIR = 'webdav:dir:';
const PREFIX_META = 'webdav:meta:';
const TTL_REDIS_DIR = 600;      // 目录缓存 10 分钟 (Redis)
const TTL_REDIS_META = 3600;    // 元数据缓存 1 小时 (Redis)

// [L1 内存缓存]: 拦截毫秒级并发 (5秒过期)
const lruCache = new LRUCache({ max: 1000, ttl: 1000 * 5 });

// [L0 静态缓存]: 永久驻留内存 (仅用于根目录和固定分类结构)
const staticXmlCache = new Map();

// [辅助] 解析年份
function getYearDate(yearStr) {
    if (!yearStr) return STATIC_FOLDER_DATE;
    const y = parseInt(yearStr);
    if (isNaN(y)) return STATIC_FOLDER_DATE;
    return new Date(`${y}-01-01T00:00:00Z`);
}

// ==========================================
// 3. 缓存管理
// ==========================================
export async function invalidateWebdavCache() {
    try {
        lruCache.clear(); 
        staticXmlCache.clear();
        const stream = redis.scanStream({ match: 'webdav:*', count: 100 });
        stream.on('data', (keys) => { if (keys.length) redis.unlink(keys); });
    } catch (e) { console.error('[WebDAV] Global cache clear failed', e); }
}

/**
 * 精准缓存清除：当剧集变动时调用
 */
export async function invalidateCacheByTmdbId(tmdbId) {
    if (!tmdbId) return;
    const tmdbStr = String(tmdbId);
    try {
        lruCache.clear(); // 1. 瞬间清空 L1

        // 2. 清除该剧集的元数据 (meta)
        const metaStream = redis.scanStream({ match: `${PREFIX_META}${tmdbStr}:*`, count: 100 });
        metaStream.on('data', (keys) => { if (keys.length) redis.unlink(keys); });

        // 3. 清除该剧集的目录结构 (dir)
        const dirStream = redis.scanStream({ match: `${PREFIX_DIR}*tmdb-${tmdbStr}*`, count: 100 });
        dirStream.on('data', (keys) => { if (keys.length) redis.unlink(keys); });

        // 4. [关键] 强制清除 "最近更新" 列表页缓存
        // 任何剧集变动都可能影响最近更新列表，必须重建
        const recentStream = redis.scanStream({ match: `${PREFIX_DIR}*最近更新*`, count: 100 });
        recentStream.on('data', (keys) => { if (keys.length) redis.unlink(keys); });

    } catch (e) { console.error('[WebDAV] Cache invalidation error:', e); }
}

// ==========================================
// 4. 分类配置 (互斥逻辑)
// ==========================================
const CATEGORY_MAP = {
    // 华语电影：是电影 & (语言是中/华) & 不是动画
    '华语电影': { 
        type: 'movie', 
        OR: [{ originalLanguage: 'zh' }, { originalLanguage: 'cn' }],
        NOT: { genres: { contains: '16' } } 
    },
    // 外语电影：是电影 & (语言不是中/华) & 不是动画
    '外语电影': { 
        type: 'movie', 
        NOT: [
            { originalLanguage: 'zh' }, 
            { originalLanguage: 'cn' }, 
            { genres: { contains: '16' } }
        ] 
    },
    // 动画电影：是电影 & 是动画 (不管语言)
    '动画电影': { type: 'movie', genres: { contains: '16' } },
    
    // 电视剧分类 (同样排除动画)
    '国产剧': { type: 'tv', OR: [{ originalLanguage: 'zh' }, { originalLanguage: 'cn' }], NOT: { genres: { contains: '16' } } },
    '欧美剧': { type: 'tv', originalLanguage: 'en', NOT: { genres: { contains: '16' } } },
    '日韩剧': { type: 'tv', OR: [{ originalLanguage: 'ja' }, { originalLanguage: 'ko' }], NOT: { genres: { contains: '16' } } },
    
    // 动漫分类
    '国漫':   { type: 'tv', genres: { contains: '16' }, originCountry: { contains: 'CN' } },
    '日番':   { type: 'tv', genres: { contains: '16' }, originCountry: { contains: 'JP' } },
    
    // 其他分类
    '纪录片': { type: 'tv', genres: { contains: '99' } },
    '综艺':   { type: 'tv', genres: { contains: '10764' } },
    '儿童':   { type: 'tv', genres: { contains: '10762' } },
    
    // 兜底分类
    '其他剧集': { 
        type: 'tv', 
        NOT: [
            { originalLanguage: 'zh' }, { originalLanguage: 'cn' },
            { originalLanguage: 'en' },
            { originalLanguage: 'ja' }, { originalLanguage: 'ko' },
            { genres: { contains: '16' } }, { genres: { contains: '99' } }, 
            { genres: { contains: '10764' } }, { genres: { contains: '10762' } }
        ]
    }
};

// ==========================================
// 5. 工具函数
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

function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const map = {
        '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg', '.png': 'image/png',
        '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.strm': 'application/vnd.apple.mpegurl',
        '.srt': 'text/plain', '.ass': 'text/plain', '.vtt': 'text/vtt', '.nfo': 'text/xml'
    };
    return map[ext] || 'application/octet-stream';
}

function appendPropXML(partsArr, href, displayName, isCollection, size, lastMod, creationDate, etag = "") {
    const modObj = lastMod ? new Date(lastMod) : STATIC_FOLDER_DATE;
    const createObj = creationDate ? new Date(creationDate) : modObj;

    const creationStr = createObj.toISOString(); 
    const lastModifiedStr = modObj.toUTCString();
    
    let safeHref = escapeXml(href);
    if (isCollection && !safeHref.endsWith('/')) safeHref += '/';

    const resourceType = isCollection ? "<D:collection/>" : "";
    
    let contentLength = "";
    const sizeNum = Number(size || 0); 
    if (!isCollection) {
        contentLength = `<D:getcontentlength>${sizeNum}</D:getcontentlength>`;
    } else if (sizeNum > 0) {
        contentLength = `<D:getcontentlength>${sizeNum}</D:getcontentlength>`;
    }

    const contentType = isCollection ? "" : `<D:getcontenttype>${getMimeType(displayName)}</D:getcontenttype>`;
    const etagNode = etag ? `<D:getetag>"${etag}"</D:getetag>` : "";
    const fileAttributes = isCollection ? "10" : "20";

    partsArr.push(`
    <D:response>
        <D:href>${safeHref}</D:href>
        <D:propstat>
            <D:prop>
                <D:displayname>${escapeXml(displayName)}</D:displayname>
                <D:resourcetype>${resourceType}</D:resourcetype>
                <D:creationdate>${creationStr}</D:creationdate>
                <D:getlastmodified>${lastModifiedStr}</D:getlastmodified>
                ${contentLength} ${contentType} ${etagNode}
                <D:Win32FileAttributes>${fileAttributes}</D:Win32FileAttributes>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
    </D:response>`);
}

function pipelineCacheMeta(pipeline, f, tmdbId) {
    const key = `${PREFIX_META}${tmdbId}:${f.cleanName}`;
    const data = { cleanName: f.cleanName, etag: f.etag, size: String(f.size), createdAt: f.createdAt };
    pipeline.set(key, JSON.stringify(data), 'EX', TTL_REDIS_META);
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
    const cacheKey = `${PREFIX_DIR}${pathStr}:${depth}`;
    
    // [性能优化] 缓存直接返回 Object {xml, etag}，避免重复计算 ETag
    if (lruCache.has(cacheKey)) return serveCacheObject(reply, req, lruCache.get(cacheKey));
    if (staticXmlCache.has(cacheKey)) return serveCacheObject(reply, req, staticXmlCache.get(cacheKey));
    
    const cachedStr = await redis.get(cacheKey);
    if (cachedStr) {
        try {
            const cacheObj = JSON.parse(cachedStr); // Redis 存的是 JSON
            lruCache.set(cacheKey, cacheObj);
            return serveCacheObject(reply, req, cacheObj);
        } catch(e) {
            // 兼容旧数据
            const oldObj = { xml: cachedStr, etag: calculateETag(cachedStr) };
            return serveCacheObject(reply, req, oldObj);
        }
    }

    const xmlParts = [];
    const encodedPathStr = parts.map(p => encodeURIComponent(p)).join('/');
    const basePathForXml = `/webdav${encodedPathStr ? '/' + encodedPathStr : ''}`;
    const selfName = parts.length > 0 ? parts[parts.length - 1] : '/';
    
    appendPropXML(xmlParts, basePathForXml, selfName, true, 0, STATIC_FOLDER_DATE, STATIC_FOLDER_DATE);

    if (depth !== '0') {
        // [Level 0] 根目录
        if (parts.length === 0) {
            appendPropXML(xmlParts, `${basePathForXml}/最近更新`, '最近更新', true, 0, STATIC_FOLDER_DATE, STATIC_FOLDER_DATE);
            appendPropXML(xmlParts, `${basePathForXml}/电影`, '电影', true, 0, STATIC_FOLDER_DATE, STATIC_FOLDER_DATE);
            appendPropXML(xmlParts, `${basePathForXml}/电视剧`, '电视剧', true, 0, STATIC_FOLDER_DATE, STATIC_FOLDER_DATE);
        }
        
        // [Level 1] 分类 or 最近更新
        else if (parts.length === 1) {
            const folderName = parts[0]; 
            
            if (folderName === '最近更新') {
                 // [动态] 30条去重
                 const recentEpisodes = await prisma.seriesEpisode.findMany({
                     distinct: ['tmdbId'], 
                     take: 30,             
                     orderBy: { createdAt: 'desc' },
                     select: { tmdbId: true }
                 });
                 const uniqueIds = recentEpisodes.map(f => f.tmdbId);
                 if (uniqueIds.length > 0) {
                     const seriesList = await prisma.seriesMain.findMany({
                         where: { tmdbId: { in: uniqueIds } },
                         select: { tmdbId: true, name: true, year: true, lastUpdated: true }
                     });
                     seriesList.sort((a, b) => uniqueIds.indexOf(a.tmdbId) - uniqueIds.indexOf(b.tmdbId));
                     for (const s of seriesList) {
                         const safeNameStr = sanitizeName(s.name);
                         const folderName = `${safeNameStr} (${s.year || 'Unknown'}) {tmdb-${s.tmdbId}}`;
                         appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(folderName)}`, folderName, true, 0, s.lastUpdated, getYearDate(s.year));
                     }
                 }
            } else {
                // [静态] 分类
                const isMovie = folderName === '电影';
                for (const [catName, condition] of Object.entries(CATEGORY_MAP)) {
                    if ((isMovie && condition.type === 'movie') || (!isMovie && condition.type === 'tv')) {
                        appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(catName)}`, catName, true, 0, STATIC_FOLDER_DATE, STATIC_FOLDER_DATE);
                    }
                }
            }
        }
        
        // [Level 2] 固定分类下的剧集
        else if (parts.length === 2 && parts[0] !== '最近更新') {
            const [typeFolder, category] = parts;
            const condition = CATEGORY_MAP[category];
            if (condition) {
                const seriesList = await prisma.seriesMain.findMany({
                    where: condition,
                    select: { tmdbId: true, name: true, year: true, lastUpdated: true },
                    orderBy: { lastUpdated: 'desc' }
                });
                for (const s of seriesList) {
                    const safeNameStr = sanitizeName(s.name);
                    const folderName = `${safeNameStr} (${s.year || 'Unknown'}) {tmdb-${s.tmdbId}}`;
                    appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(folderName)}`, folderName, true, 0, s.lastUpdated, getYearDate(s.year));
                }
            }
        }
        
        // [Level 3/4] 剧集详情 (通用路径)
        // [健壮性修复] 必须检查 parts.length > 0 防止根目录越界
        if (parts.length > 0) {
            const lastPart = parts[parts.length - 1];
            const prevPart = parts.length >= 2 ? parts[parts.length - 2] : null;
            
            const tmdbIdMatch = lastPart ? lastPart.match(/\{tmdb-(\d+)\}/) : null;
            const seasonMatch = lastPart ? lastPart.match(/Season (\d+)/) : null;
            const parentIdMatch = prevPart ? prevPart.match(/\{tmdb-(\d+)\}/) : null;

            // [场景 A] 剧集根目录
            if (tmdbIdMatch && !seasonMatch) {
                const tmdbId = parseInt(tmdbIdMatch[1]);
                const seasonCounts = await prisma.seriesEpisode.groupBy({
                    by: ['season'], where: { tmdbId, type: { not: 'subtitle' } }, 
                    _max: { createdAt: true }, _min: { createdAt: true }, _sum: { size: true } 
                });
                const seriesInfo = await prisma.seriesMain.findUnique({ where: { tmdbId }, select: { type: true } });

                if (seriesInfo?.type === 'movie') {
                    const files = await prisma.seriesEpisode.findMany({ 
                        where: { tmdbId, type: { not: 'subtitle' } },
                        select: { cleanName: true, size: true, createdAt: true, etag: true }
                    });
                    const pipeline = redis.pipeline();
                    for (const f of files) {
                        appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(f.cleanName)}`, f.cleanName, false, f.size, f.createdAt, f.createdAt, f.etag);
                        pipelineCacheMeta(pipeline, f, tmdbId);
                    }
                    pipeline.exec().catch(() => {});
                } else {
                    seasonCounts.sort((a, b) => (a.season||0) - (b.season||0));
                    for (const s of seasonCounts) {
                        const seasonName = `Season ${String(s.season).padStart(2, '0')}`;
                        const lastMod = s._max.createdAt || STATIC_FOLDER_DATE;
                        const creation = s._min.createdAt || lastMod;
                        const totalSize = s._sum.size || 0; 
                        appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(seasonName)}`, seasonName, true, totalSize, lastMod, creation);
                    }
                }
            }
            
            // [场景 B] 季目录
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
                    appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(f.cleanName)}`, f.cleanName, false, f.size, f.createdAt, f.createdAt, f.etag);
                    pipelineCacheMeta(pipeline, f, tmdbId);
                }
                pipeline.exec().catch(() => {});
            }
        }
    }

    const finalXml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${xmlParts.join('')}</D:multistatus>`;
    
    // [关键修复] 缓存决策逻辑
    const cacheObject = { xml: finalXml, etag: calculateETag(finalXml) };
    const isRecentUpdates = parts.length === 1 && parts[0] === '最近更新';
    
    // 1. 静态目录 -> 内存 Map
    if (parts.length <= 1 && depth !== '0' && !isRecentUpdates) {
        staticXmlCache.set(cacheKey, cacheObject);
    } else {
        // 2. 动态目录(最近更新, 详情页) -> Redis
        await redis.set(cacheKey, JSON.stringify(cacheObject), 'EX', TTL_REDIS_DIR);
        lruCache.set(cacheKey, cacheObject);
    }
    
    return serveCacheObject(reply, req, cacheObject);
}

function serveCacheObject(reply, req, cacheObj) {
    if (typeof cacheObj === 'string') { // 兼容旧缓存
        const etag = calculateETag(cacheObj);
        reply.header('ETag', etag);
        if (req.headers['if-none-match'] === etag) return reply.code(304).send();
        return sendXml(reply, cacheObj);
    }
    reply.header('ETag', cacheObj.etag);
    if (req.headers['if-none-match'] === cacheObj.etag) return reply.code(304).send();
    return sendXml(reply, cacheObj.xml);
}

// ==========================================
// 8. GET/HEAD 处理器
// ==========================================
async function handleGet(req, reply, pathStr, parts) {
    const fileName = decodeURIComponent(parts[parts.length - 1]);
    let tmdbId = null;
    for(const part of parts) {
        const match = part.match(/\{tmdb-(\d+)\}/);
        if(match) { tmdbId = parseInt(match[1]); break; }
    }

    if (!tmdbId) return reply.code(403).send('Directory listing not allowed via GET');

    const cacheKey = `${PREFIX_META}${tmdbId}:${fileName}`;
    let file = lruCache.get(cacheKey);

    if (!file) {
        const cachedMetaStr = await redis.get(cacheKey);
        if (cachedMetaStr) {
            file = JSON.parse(cachedMetaStr);
            file.createdAt = new Date(file.createdAt);
            lruCache.set(cacheKey, file);
        } else {
            file = await prisma.seriesEpisode.findFirst({
                where: { tmdbId, cleanName: fileName },
                select: { cleanName: true, etag: true, size: true, createdAt: true }
            });
            if (file) {
                const cacheData = { ...file, size: String(file.size) };
                await redis.set(cacheKey, JSON.stringify(cacheData), 'EX', TTL_REDIS_META);
                lruCache.set(cacheKey, file);
            }
        }
    }

    if (!file) return reply.code(404).send('File not found');

    const headers = {
        'Content-Type': getMimeType(fileName),
        'Content-Length': String(file.size),
        'Last-Modified': new Date(file.createdAt).toUTCString(),
        'ETag': `"${file.etag}"`,
        'Accept-Ranges': 'bytes'
    };

    if (req.method === 'HEAD') { reply.headers(headers); return reply.send(); }

    try {
        const downloadUrl = await core123.getDownloadUrlByHash(file.cleanName, file.etag, Number(file.size));
        if (!downloadUrl) throw new Error('Link generation failed');
        return reply.redirect(downloadUrl);
    } catch (e) {
        req.log.error(e, `[WebDAV] Link Error: ${fileName}`);
        return reply.code(502).send('Upstream Error');
    }
}

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