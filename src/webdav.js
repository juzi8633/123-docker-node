// src/webdav.js
import { prisma } from './db.js';
import { core123 } from './services/core123.js';
import redis from './redis.js';
import path from 'path';
import crypto from 'crypto';
import { LRUCache } from 'lru-cache';

// ==========================================
// 配置区域
// ==========================================
const WEBDAV_USER = process.env.WEBDAV_USER || "admin";
const WEBDAV_PASSWORD = process.env.WEBDAV_PASSWORD || "password";

// [核心优化] 服务启动时间锚点
// 用于静态目录（根目录、分类目录），保证 XML 内容稳定，使 ETag 稳定，从而让 304 缓存生效。
const STARTUP_TIME = new Date(); 

// ==========================================
// 缓存策略 (三级缓存体系)
// ==========================================
const PREFIX_DIR = 'webdav:dir:';
const PREFIX_META = 'webdav:meta:';
const TTL_REDIS_DIR = 600;      // L2 (Redis) 目录缓存 10 分钟
const TTL_REDIS_META = 3600;    // L2 (Redis) 元数据缓存 1 小时

// [⚡️ L1 内存缓存]
const lruCache = new LRUCache({
    max: 1000,
    ttl: 1000 * 5, 
});

// [⚡️ 静态 XML 缓存]
const staticXmlCache = new Map();

/**
 * 主动清除 WebDAV 缓存 (全量清除 - 兜底用)
 */
export async function invalidateWebdavCache() {
    try {
        lruCache.clear(); 
        staticXmlCache.clear();
        const stream = redis.scanStream({ match: 'webdav:*', count: 100 });
        stream.on('data', (keys) => {
            if (keys.length) redis.unlink(keys);
        });
        stream.on('end', () => console.log(`[WebDAV] 🧹 All Caches (L1/Static/Redis) cleared`));
    } catch (e) {
        console.error('[WebDAV] Cache clear failed', e);
    }
}

/**
 * [新增] 精准清除指定剧集的缓存 (增量更新用)
 * @param {number|string} tmdbId - 剧集的 TMDB ID
 */
export async function invalidateCacheByTmdbId(tmdbId) {
    if (!tmdbId) return;
    const tmdbStr = String(tmdbId);
    
    // console.log(`[WebDAV] 🧹 Granular cache clear for TMDB: ${tmdbStr}`);

    try {
        // 1. 清除 L1 内存缓存
        lruCache.clear();

        // 2. 清除 Redis 中该剧集的文件元数据 (Metadata)
        const metaStream = redis.scanStream({ match: `${PREFIX_META}${tmdbStr}:*`, count: 100 });
        metaStream.on('data', (keys) => {
            if (keys.length) redis.unlink(keys);
        });

        // 3. 清除该剧集的目录结构 (Directory XML)
        const dirStream = redis.scanStream({ match: `${PREFIX_DIR}*tmdb-${tmdbStr}*`, count: 100 });
        dirStream.on('data', (keys) => {
            if (keys.length) redis.unlink(keys);
        });

    } catch (e) {
        console.error('[WebDAV] Granular clear failed', e);
    }
}

// 分类映射配置
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
    '未分类': { 
        type: 'tv', 
        NOT: [
            { originalLanguage: 'zh' }, { originalLanguage: 'cn' },
            { originalLanguage: 'en' },
            { originalLanguage: 'ja' }, { originalLanguage: 'ko' },
            { genres: { contains: '16' } },    
            { genres: { contains: '99' } },    
            { genres: { contains: '10764' } }, 
            { genres: { contains: '10762' } }  
        ]
    }
};

// ==========================================
// 工具函数
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

/**
 * [优化] XML 构建器 - 时间处理逻辑增强
 * 策略：
 * 1. 静态目录 (Level 0/1) -> 传入 STARTUP_TIME。保证 ETag 稳定。
 * 2. 动态目录 (Level 2/3) -> 传入 DB 中的时间。保证内容更新后时间变动。
 * 3. 兜底 -> 如果 DB 时间为空，回退到 STARTUP_TIME，避免 1970 问题。
 */
function appendPropXML(partsArr, href, displayName, isCollection, size = 0, lastMod, etag = "") {
    let dateObj;
    if (lastMod instanceof Date) {
        dateObj = lastMod;
    } else if (lastMod) {
        dateObj = new Date(lastMod);
    } else {
        // [修正] 默认为启动时间，而不是当前时间。避免每次请求 XML 内容变动导致 ETag 失效。
        dateObj = STARTUP_TIME;
    }
    
    // WebDAV 推荐格式
    const creation = dateObj.toISOString(); 
    const lastModified = dateObj.toUTCString();
    
    let safeHref = escapeXml(href);
    // 规范：WebDAV 集合必须以 / 结尾
    if (isCollection && !safeHref.endsWith('/')) safeHref += '/';

    const resourceType = isCollection ? "<D:collection/>" : "";
    const contentLength = isCollection ? "" : `<D:getcontentlength>${size}</D:getcontentlength>`;
    const contentType = isCollection ? "" : `<D:getcontenttype>${getMimeType(displayName)}</D:getcontenttype>`;
    const etagNode = etag ? `<D:getetag>"${etag}"</D:getetag>` : "";
    
    // [🛡️ Windows 兼容] Win32FileAttributes: 10=Directory, 20=File (Archive)
    const fileAttributes = isCollection ? "10" : "20";

    partsArr.push(`
    <D:response>
        <D:href>${safeHref}</D:href>
        <D:propstat>
            <D:prop>
                <D:displayname>${escapeXml(displayName)}</D:displayname>
                <D:resourcetype>${resourceType}</D:resourcetype>
                <D:creationdate>${creation}</D:creationdate>
                <D:getlastmodified>${lastModified}</D:getlastmodified>
                ${contentLength}
                ${contentType}
                ${etagNode}
                <D:Win32FileAttributes>${fileAttributes}</D:Win32FileAttributes>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
    </D:response>`);
}

// ==========================================
// 核心请求处理器
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
    // 移除末尾斜杠，统一处理逻辑 (根目录除外)
    if (urlPath.length > 1 && urlPath.endsWith('/')) urlPath = urlPath.slice(0, -1);
    
    const parts = urlPath.split('/').filter(p => p);
    const method = req.method.toUpperCase();

    try {
        switch (method) {
            case 'PROPFIND': return await handlePropfind(req, reply, urlPath, parts);
            case 'GET':
            case 'HEAD': return await handleGet(req, reply, urlPath, parts);
            
            // [🛡️ Windows 兼容] 声明支持的方法
            case 'OPTIONS':
                reply.header('DAV', '1, 2');
                reply.header('Allow', 'OPTIONS, GET, HEAD, PROPFIND, PROPPATCH, LOCK, UNLOCK');
                reply.header('MS-Author-Via', 'DAV'); 
                return reply.send();
            
            // [🛡️ Windows 兼容] 哑巴接口
            case 'PROPPATCH': return handleDummyProppatch(reply, urlPath);
            case 'LOCK': return handleDummyLock(req, reply, urlPath);
            case 'UNLOCK': return reply.code(204).send();

            // 明确拒绝写入
            case 'PUT':
            case 'DELETE':
            case 'MKCOL':
            case 'MOVE':
            case 'COPY': return reply.code(403).send('Read-only file system');
            
            default: return reply.code(405).send('Method Not Allowed');
        }
    } catch (e) {
        req.log.error(e, `[WebDAV] Error handling ${urlPath}`);
        return reply.code(500).send('Internal Server Error');
    }
}

// ==========================================
// 业务逻辑实现
// ==========================================

async function handlePropfind(req, reply, pathStr, parts) {
    const depth = req.headers['depth'] || '1';
    const cacheKey = `${PREFIX_DIR}${pathStr}:${depth}`;
    
    // [⚡️ 优化 1] L1 内存缓存命中
    if (lruCache.has(cacheKey)) {
        const cachedXml = lruCache.get(cacheKey);
        const etag = calculateETag(cachedXml);
        if (req.headers['if-none-match'] === etag) return reply.code(304).send();
        reply.header('ETag', etag);
        return sendXml(reply, cachedXml);
    }
    
    // [⚡️ 优化 2] 静态路径直出
    if (staticXmlCache.has(cacheKey)) {
        return sendXml(reply, staticXmlCache.get(cacheKey));
    }

    // [⚡️ 优化 3] L2 Redis 缓存命中
    const cachedXml = await redis.get(cacheKey);
    if (cachedXml) {
        lruCache.set(cacheKey, cachedXml); // 回填 L1
        const etag = calculateETag(cachedXml);
        if (req.headers['if-none-match'] === etag) return reply.code(304).send();
        reply.header('ETag', etag);
        return sendXml(reply, cachedXml);
    }

    // --- 数据构建 ---
    const xmlParts = [];
    
    // [🔧 路径安全] 强制使用 URI 编码重建 href
    const encodedPathStr = parts.map(p => encodeURIComponent(p)).join('/');
    const basePathForXml = `/webdav${encodedPathStr ? '/' + encodedPathStr : ''}`;
    const selfName = parts.length > 0 ? parts[parts.length - 1] : '/';
    
    // [修正] 自身属性：统一使用 STARTUP_TIME，确保进入目录时属性稳定
    // 虽然这里不查 DB 牺牲了一点真实性，但换来了无需 DB 查询的高性能 "Self" 节点生成
    appendPropXML(xmlParts, basePathForXml, selfName, true, 0, STARTUP_TIME);

    if (depth !== '0') {
        // Level 0: Root
        if (parts.length === 0) {
            // [修正] 使用 STARTUP_TIME
            appendPropXML(xmlParts, `${basePathForXml}/电影`, '电影', true, 0, STARTUP_TIME);
            appendPropXML(xmlParts, `${basePathForXml}/电视剧`, '电视剧', true, 0, STARTUP_TIME);
        }
        
        // Level 1: Categories
        else if (parts.length === 1) {
            const typeFolder = parts[0]; 
            const isMovie = typeFolder === '电影';
            const categories = Object.entries(CATEGORY_MAP);

            for (const [catName, condition] of categories) {
                if ((isMovie && condition.type === 'movie') || (!isMovie && condition.type === 'tv')) {
                    // [修正] 使用 STARTUP_TIME
                    appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(catName)}`, catName, true, 0, STARTUP_TIME);
                }
            }
        }
        
        // Level 2: Series List
        else if (parts.length === 2) {
            const [typeFolder, category] = parts;
            const condition = CATEGORY_MAP[category];
            
            if (condition) {
                const seriesList = await prisma.seriesMain.findMany({
                    where: condition,
                    select: { 
                        tmdbId: true, 
                        name: true, 
                        year: true, 
                        lastUpdated: true 
                    },
                    orderBy: { lastUpdated: 'desc' }
                });

                for (const s of seriesList) {
                    const safeNameStr = sanitizeName(s.name);
                    const folderName = `${safeNameStr} (${s.year || 'Unknown'}) {tmdb-${s.tmdbId}}`;
                    // [真实] 使用 DB 中的 lastUpdated
                    appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(folderName)}`, folderName, true, 0, s.lastUpdated);
                }
            }
        }
        
        // Level 3: Files/Seasons
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
                    for (const f of files) {
                        // [真实] 使用 DB 中的 createdAt
                        appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(f.cleanName)}`, f.cleanName, false, Number(f.size), f.createdAt, f.etag);
                        cacheFileMeta(f, tmdbId);
                    }
                } else {
                    // [关键修正] 聚合查询：获取每季最新时间
                    const seasons = await prisma.seriesEpisode.groupBy({
                        by: ['season'], 
                        where: { tmdbId, type: { not: 'subtitle' } }, 
                        _max: { createdAt: true } // <--- 重点：获取该季最新一集的添加时间
                    });
                    seasons.sort((a, b) => a.season - b.season);
                    for (const s of seasons) {
                        const seasonName = `Season ${String(s.season).padStart(2, '0')}`;
                        // 使用 _max.createdAt 作为季文件夹的时间
                        const seasonDate = s._max.createdAt || STARTUP_TIME;
                        appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(seasonName)}`, seasonName, true, 0, seasonDate);
                    }
                }
            }
        }
        
        // Level 4: Episodes
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

                for (const f of files) {
                    appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(f.cleanName)}`, f.cleanName, false, Number(f.size), f.createdAt, f.etag);
                    cacheFileMeta(f, tmdbId);
                }
            }
        }
    }

    const finalXml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${xmlParts.join('')}</D:multistatus>`;
    
    // [⚡️ 逻辑] 静态目录存入 Static Cache，动态目录存入 Redis + L1
    if (parts.length <= 1 && depth !== '0') {
        staticXmlCache.set(cacheKey, finalXml);
    } else {
        await redis.set(cacheKey, finalXml, 'EX', TTL_REDIS_DIR);
        lruCache.set(cacheKey, finalXml);
    }
    
    const etag = calculateETag(finalXml);
    reply.header('ETag', etag);
    return sendXml(reply, finalXml);
}

async function handleGet(req, reply, pathStr, parts) {
    const fileName = decodeURIComponent(parts[parts.length - 1]);
    
    let tmdbId = null;
    const pathMatch = pathStr.match(/\{tmdb-(\d+)\}/);
    if (pathMatch) tmdbId = parseInt(pathMatch[1]);

    if (!tmdbId) return reply.code(404).send('File context not found');

    const cacheKey = `${PREFIX_META}${tmdbId}:${fileName}`;
    
    // [⚡️ L1 缓存] 优先查内存
    let file = lruCache.get(cacheKey);

    if (!file) {
        // L2 Redis
        const cachedMetaStr = await redis.get(cacheKey);
        if (cachedMetaStr) {
            file = JSON.parse(cachedMetaStr);
            file.createdAt = new Date(file.createdAt);
            lruCache.set(cacheKey, file); // 回填 L1
        } else {
            // [⚡️ DB 瘦身] Select 4 个字段
            file = await prisma.seriesEpisode.findFirst({
                where: { tmdbId, cleanName: fileName },
                select: { cleanName: true, etag: true, size: true, createdAt: true }
            });
            if (file) {
                await redis.set(cacheKey, JSON.stringify(file), 'EX', TTL_REDIS_META);
                lruCache.set(cacheKey, file); // 回填 L1
            }
        }
    }

    if (!file) return reply.code(404).send('File not found in DB');

    const headers = {
        'Content-Type': getMimeType(fileName),
        'Content-Length': String(file.size),
        'Last-Modified': new Date(file.createdAt).toUTCString(), // 真实的文件创建时间
        'ETag': `"${file.etag}"`,
        'Accept-Ranges': 'bytes'
    };

    // HEAD 立即返回
    if (req.method === 'HEAD') {
        reply.headers(headers);
        return reply.send();
    }

    // GET 获取直链
    try {
        const downloadUrl = await core123.getDownloadUrlByHash(file.cleanName, file.etag, Number(file.size));
        if (!downloadUrl) throw new Error('Link generation failed');

        req.log.info({ file: fileName }, `[WebDAV] Redirect -> Stream`);
        return reply.redirect(downloadUrl);
    } catch (e) {
        req.log.error(e, `[WebDAV] Link Error: ${fileName}`);
        return reply.code(502).send('Upstream Error');
    }
}

// [🛡️ Windows 兼容]
function handleDummyProppatch(reply, urlPath) {
    const xml = `<?xml version="1.0" encoding="utf-8" ?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${escapeXml(urlPath)}</D:href><D:propstat><D:prop><D:Win32CreationTime/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    return sendXml(reply, xml);
}

// [🛡️ Windows 兼容]
function handleDummyLock(req, reply, urlPath) {
    const token = `urn:uuid:${crypto.randomUUID()}`;
    const xml = `<?xml version="1.0" encoding="utf-8" ?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>Infinity</D:depth><D:owner><D:href>Unknown</D:href></D:owner><D:timeout>Second-604800</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`;
    reply.header('Lock-Token', `<${token}>`);
    return sendXml(reply, xml);
}

function sendXml(reply, xml) {
    return reply.type('application/xml; charset=utf-8').header('DAV', '1, 2').status(207).send(xml);
}

function cacheFileMeta(f, tmdbId) {
    const key = `${PREFIX_META}${tmdbId}:${f.cleanName}`;
    const data = { cleanName: f.cleanName, etag: f.etag, size: Number(f.size), createdAt: f.createdAt };
    // 只写 Redis (L2)，下次读取时会自动填入 L1
    redis.set(key, JSON.stringify(data), 'EX', TTL_REDIS_META).catch(() => {});
}