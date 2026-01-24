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

// [核心优化] 时间锚点
// 固定时间戳，确保静态目录 ETag 永不抖动，防止客户端全量扫库
const STATIC_FOLDER_DATE = new Date('2023-01-01T00:00:00Z'); 

// ==========================================
// 2. 缓存策略
// ==========================================
const PREFIX_DIR = 'webdav:dir:';
const PREFIX_META = 'webdav:meta:';
const TTL_REDIS_DIR = 600;      // 目录缓存 10 分钟
const TTL_REDIS_META = 3600;    // 元数据缓存 1 小时

// [L1 内存缓存]: 拦截高频并发
const lruCache = new LRUCache({ max: 1000, ttl: 1000 * 5 });

// [L0 静态缓存]: 永久驻留
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
        // 使用 scanStream 避免阻塞 Redis
        const stream = redis.scanStream({ match: 'webdav:*', count: 100 });
        stream.on('data', (keys) => { if (keys.length) redis.unlink(keys); });
    } catch (e) { console.error(e); }
}

export async function invalidateCacheByTmdbId(tmdbId) {
    if (!tmdbId) return;
    const tmdbStr = String(tmdbId);
    try {
        lruCache.clear();
        // 清除元数据
        const metaStream = redis.scanStream({ match: `${PREFIX_META}${tmdbStr}:*`, count: 100 });
        metaStream.on('data', (keys) => { if (keys.length) redis.unlink(keys); });
        // 清除目录结构
        const dirStream = redis.scanStream({ match: `${PREFIX_DIR}*tmdb-${tmdbStr}*`, count: 100 });
        dirStream.on('data', (keys) => { if (keys.length) redis.unlink(keys); });
    } catch (e) { console.error(e); }
}

// ==========================================
// 4. 分类配置
// ==========================================
const CATEGORY_MAP = {
    '华语电影': { type: 'movie', OR: [{ originalLanguage: 'zh' }, { originalLanguage: 'cn' }] },
    '外语电影': { type: 'movie', NOT: [{ originalLanguage: 'zh' }, { originalLanguage: 'cn' }] },
    '动画电影': { type: 'movie', genres: { contains: '16' } },
    '国产剧': { type: 'tv', OR: [{ originalLanguage: 'zh' }, { originalLanguage: 'cn' }], NOT: { genres: { contains: '16' } } },
    '欧美剧': { type: 'tv', originalLanguage: 'en', NOT: { genres: { contains: '16' } } },
    '日韩剧': { type: 'tv', OR: [{ originalLanguage: 'ja' }, { originalLanguage: 'ko' }], NOT: { genres: { contains: '16' } } },
    '国漫':   { type: 'tv', genres: { contains: '16' }, originCountry: { contains: 'CN' } },
    '日番':   { type: 'tv', genres: { contains: '16' }, originCountry: { contains: 'JP' } },
    '纪录片': { type: 'tv', genres: { contains: '99' } },
    '综艺':   { type: 'tv', genres: { contains: '10764' } },
    '儿童':   { type: 'tv', genres: { contains: '10762' } },
    '未分类': { type: 'tv', NOT: [{ originalLanguage: 'zh' }, { originalLanguage: 'cn' }, { originalLanguage: 'en' }, { originalLanguage: 'ja' }, { originalLanguage: 'ko' }, { genres: { contains: '16' } }, { genres: { contains: '99' } }, { genres: { contains: '10764' } }, { genres: { contains: '10762' } }] }
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
    
    // 大小处理：仅文件或非空文件夹显示
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
                ${contentLength}
                ${contentType}
                ${etagNode}
                <D:Win32FileAttributes>${fileAttributes}</D:Win32FileAttributes>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
    </D:response>`);
}

// [性能优化] 使用 Pipeline 批量缓存元数据
function pipelineCacheMeta(pipeline, f, tmdbId) {
    const key = `${PREFIX_META}${tmdbId}:${f.cleanName}`;
    const data = { cleanName: f.cleanName, etag: f.etag, size: String(f.size), createdAt: f.createdAt };
    // 使用 pipeline.set 而不是 redis.set
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
            case 'HEAD': return await handleGet(req, reply, urlPath, parts); // 统一处理
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
    
    // 缓存层级检查
    if (lruCache.has(cacheKey)) return serveCache(reply, req, lruCache.get(cacheKey));
    if (staticXmlCache.has(cacheKey)) return serveCache(reply, req, staticXmlCache.get(cacheKey));
    const cachedXml = await redis.get(cacheKey);
    if (cachedXml) {
        lruCache.set(cacheKey, cachedXml);
        return serveCache(reply, req, cachedXml);
    }

    const xmlParts = [];
    const encodedPathStr = parts.map(p => encodeURIComponent(p)).join('/');
    const basePathForXml = `/webdav${encodedPathStr ? '/' + encodedPathStr : ''}`;
    const selfName = parts.length > 0 ? parts[parts.length - 1] : '/';
    
    // 添加自身节点
    appendPropXML(xmlParts, basePathForXml, selfName, true, 0, STATIC_FOLDER_DATE, STATIC_FOLDER_DATE);

    if (depth !== '0') {
        // [Level 0] 根
        if (parts.length === 0) {
            appendPropXML(xmlParts, `${basePathForXml}/电影`, '电影', true, 0, STATIC_FOLDER_DATE, STATIC_FOLDER_DATE);
            appendPropXML(xmlParts, `${basePathForXml}/电视剧`, '电视剧', true, 0, STATIC_FOLDER_DATE, STATIC_FOLDER_DATE);
        }
        
        // [Level 1] 分类
        else if (parts.length === 1) {
            const typeFolder = parts[0]; 
            const isMovie = typeFolder === '电影';
            for (const [catName, condition] of Object.entries(CATEGORY_MAP)) {
                if ((isMovie && condition.type === 'movie') || (!isMovie && condition.type === 'tv')) {
                    appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(catName)}`, catName, true, 0, STATIC_FOLDER_DATE, STATIC_FOLDER_DATE);
                }
            }
        }
        
        // [Level 2] 剧集
        else if (parts.length === 2) {
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
                    // CreationDate = 剧集年份; LastMod = 数据库更新时间
                    appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(folderName)}`, folderName, true, 0, s.lastUpdated, getYearDate(s.year));
                }
            }
        }
        
        // [Level 3] 季 / 电影文件
        else if (parts.length === 3) {
            const [typeFolder, category, seriesFolder] = parts;
            const tmdbIdMatch = seriesFolder.match(/\{tmdb-(\d+)\}/);

            if (tmdbIdMatch) {
                const tmdbId = parseInt(tmdbIdMatch[1]);
                const isMovie = typeFolder === '电影';

                if (isMovie) {
                    const files = await prisma.seriesEpisode.findMany({ 
                        where: { tmdbId, type: { not: 'subtitle' } },
                        select: { cleanName: true, size: true, createdAt: true, etag: true }
                    });
                    
                    // [性能优化] 使用 Pipeline 批量写入 Redis
                    const pipeline = redis.pipeline();
                    for (const f of files) {
                        appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(f.cleanName)}`, f.cleanName, false, f.size, f.createdAt, f.createdAt, f.etag);
                        pipelineCacheMeta(pipeline, f, tmdbId);
                    }
                    pipeline.exec().catch(e => console.error('[Redis] Pipeline Error', e)); 
                    
                } else {
                    const seasons = await prisma.seriesEpisode.groupBy({
                        by: ['season'], 
                        where: { tmdbId, type: { not: 'subtitle' } }, 
                        _max: { createdAt: true },
                        _min: { createdAt: true }, 
                        _sum: { size: true } 
                    });
                    seasons.sort((a, b) => a.season - b.season);
                    for (const s of seasons) {
                        const seasonName = `Season ${String(s.season).padStart(2, '0')}`;
                        const lastMod = s._max.createdAt || STATIC_FOLDER_DATE;
                        const creation = s._min.createdAt || lastMod;
                        const totalSize = s._sum.size || 0; 
                        appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(seasonName)}`, seasonName, true, totalSize, lastMod, creation);
                    }
                }
            }
        }
        
        // [Level 4] 单集文件
        else if (parts.length === 4) {
            const [typeFolder, category, seriesFolder, seasonFolder] = parts;
            const tmdbIdMatch = seriesFolder.match(/\{tmdb-(\d+)\}/);
            const seasonMatch = seasonFolder.match(/Season (\d+)/);

            if (tmdbIdMatch && seasonMatch) {
                const tmdbId = parseInt(tmdbIdMatch[1]);
                const season = parseInt(seasonMatch[1]);
                
                const files = await prisma.seriesEpisode.findMany({
                    where: { tmdbId, season, type: { not: 'subtitle' } }, 
                    select: { cleanName: true, size: true, createdAt: true, etag: true },
                    orderBy: { episode: 'asc' }
                });

                // [性能优化] 使用 Pipeline 批量写入 Redis
                const pipeline = redis.pipeline();
                for (const f of files) {
                    appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(f.cleanName)}`, f.cleanName, false, f.size, f.createdAt, f.createdAt, f.etag);
                    pipelineCacheMeta(pipeline, f, tmdbId);
                }
                pipeline.exec().catch(e => console.error('[Redis] Pipeline Error', e));
            }
        }
    }

    const finalXml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${xmlParts.join('')}</D:multistatus>`;
    
    // 写入响应缓存
    if (parts.length <= 1 && depth !== '0') {
        staticXmlCache.set(cacheKey, finalXml);
    } else {
        await redis.set(cacheKey, finalXml, 'EX', TTL_REDIS_DIR);
        lruCache.set(cacheKey, finalXml);
    }
    
    return serveCache(reply, req, finalXml);
}

function serveCache(reply, req, xmlStr) {
    const etag = calculateETag(xmlStr);
    reply.header('ETag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return sendXml(reply, xmlStr);
}

// ==========================================
// 8. GET/HEAD 处理器
// ==========================================
async function handleGet(req, reply, pathStr, parts) {
    const fileName = decodeURIComponent(parts[parts.length - 1]);
    
    let tmdbId = null;
    const pathMatch = pathStr.match(/\{tmdb-(\d+)\}/);
    if (pathMatch) tmdbId = parseInt(pathMatch[1]);

    // [逻辑严密性] 拦截对目录的 GET 请求
    // 如果没有 TMDB ID 且看起来像是目录访问，直接拒绝。
    // 这防止了播放器把目录当文件下载，也保护了服务器资源。
    if (!tmdbId) {
        return reply.code(403).send('Directory listing not allowed via GET');
    }

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

    // [逻辑严密性] HEAD 请求立即返回，不进行 302
    if (req.method === 'HEAD') { reply.headers(headers); return reply.send(); }

    try {
        const downloadUrl = await core123.getDownloadUrlByHash(file.cleanName, file.etag, Number(file.size));
        if (!downloadUrl) throw new Error('Link generation failed');
        // req.log.info({ file: fileName }, `[WebDAV] Redirect -> Stream`);
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