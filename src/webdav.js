// src/webdav.js
import { prisma } from './db.js';
import { core123 } from './services/core123.js';
import redis from './redis.js';
import path from 'path';
import crypto from 'crypto';
import { LRUCache } from 'lru-cache';
import { Readable } from 'stream';

// ==========================================
// 1. 配置区域
// ==========================================
const WEBDAV_USER = process.env.WEBDAV_USER || "admin";
const WEBDAV_PASSWORD = process.env.WEBDAV_PASSWORD || "password";

// [修改] 默认基准时间 (当分类为空或查不到时间时使用)
const DEFAULT_DATE = new Date('2023-01-01T00:00:00Z');

// ==========================================
// 2. 缓存策略 (L1 Cache)
// ==========================================
const PREFIX_DIR = 'webdav:dir:';
const PREFIX_META = 'webdav:meta:';
const TTL_REDIS_META = 3600;    // 元数据缓存 1 小时 (Redis)

// [L1 内存缓存]: 拦截毫秒级并发 (5秒过期)
// 注意：流式输出后，大目录不再缓存 XML 字符串，主要缓存 meta 对象
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
    // 确保返回 WebDAV 兼容的 HTTP 日期格式
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

// [新增] 精准获取分类最大时间戳 (聚合查询)
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
 * [重构] 生成单条 WebDAV XML 片段
 * @param {string} href - 必须是 URI 编码后的完整路径
 * @param {string} displayName - 原始显示名称 (函数内部会做 XML 转义)
 */
function genPropXML(href, displayName, isCollection, size, lastMod, creationDate, etag = "") {
    const modObj = lastMod ? new Date(lastMod) : DEFAULT_DATE;
    const createObj = creationDate ? new Date(creationDate) : modObj;

    const safeHref = escapeXml(href); // XML 转义 (防止 href 中包含 & 等字符破坏 XML 结构)
    
    if (isCollection && !safeHref.endsWith('/')) {
        // 目录通常以 / 结尾，虽然不是强制，但有助于客户端识别
    }

    const resourceType = isCollection ? "<D:collection/>" : "";
    const contentLength = isCollection ? "" : `<D:getcontentlength>${Number(size || 0)}</D:getcontentlength>`;
    const contentType = isCollection ? "" : `<D:getcontenttype>${getMimeType(displayName)}</D:getcontenttype>`;
    const etagNode = etag ? `<D:getetag>"${etag}"</D:getetag>` : "";
    const fileAttributes = isCollection ? "10" : "20";

    // 紧凑输出
    return `<D:response><D:href>${safeHref}</D:href><D:propstat><D:prop><D:displayname>${escapeXml(displayName)}</D:displayname><D:resourcetype>${resourceType}</D:resourcetype><D:creationdate>${createObj.toISOString()}</D:creationdate><D:getlastmodified>${toRFC1123(modObj)}</D:getlastmodified>${contentLength}${contentType}${etagNode}<D:Win32FileAttributes>${fileAttributes}</D:Win32FileAttributes></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function pipelineCacheMeta(pipeline, f, tmdbId) {
    const key = `${PREFIX_META}${tmdbId}:${f.cleanName}`;
    const data = { cleanName: f.cleanName, etag: f.etag, size: String(f.size), createdAt: f.createdAt };
    pipeline.set(key, JSON.stringify(data), 'EX', TTL_REDIS_META);
}

// ==========================================
// 4. 分类配置 (保持原逻辑)
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
// 5. XML 流式生成器 (核心)
// ==========================================
async function* xmlStreamGenerator(pathStr, parts, depth, req, folderLastMod) {
    // 1. 输出 XML 头部
    yield `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">`;

    // 路径处理：确保 URL 编码
    const encodedPathStr = parts.map(p => encodeURIComponent(p)).join('/');
    const basePathForXml = `/webdav${encodedPathStr ? '/' + encodedPathStr : ''}`;
    
    // 获取当前文件夹显示的名称（URL 解码后的可读名称）
    const selfName = parts.length > 0 ? decodeURIComponent(parts[parts.length - 1]) : '/';

    // 2. 生成自身节点 (Self)
    // [关键] 使用传入的 folderLastMod，确保 Header ETag 与 Body LastModified 一致
    yield genPropXML(basePathForXml, selfName, true, 0, folderLastMod, folderLastMod);

    if (depth !== '0') {
        // === [Level 0] 根目录 ===
        if (parts.length === 0) {
            // 并行查询三个主要目录的时间
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
        
        // === [Level 1] 分类 或 最近更新 ===
        else if (parts.length === 1) {
            const folderName = parts[0]; 
            
            if (folderName === '最近更新') {
                // 1. 获取最近更新了"文件"的剧集 ID
                const recentEpisodes = await prisma.seriesEpisode.groupBy({
                    by: ['tmdbId'],
                    _max: { createdAt: true },
                    orderBy: { _max: { createdAt: 'desc' } },
                    take: 50
                });
                
                // 2. 获取最近更新了"元数据"的剧集 ID
                const recentMeta = await prisma.seriesMain.findMany({
                    orderBy: { lastUpdated: 'desc' },
                    take: 50,
                    select: { tmdbId: true, lastUpdated: true }
                });

                // 3. 合并 ID 并去重
                const mixedIds = new Set([
                    ...recentEpisodes.map(e => e.tmdbId),
                    ...recentMeta.map(m => m.tmdbId)
                ]);

                if (mixedIds.size > 0) {
                    const seriesList = await prisma.seriesMain.findMany({
                        where: { tmdbId: { in: Array.from(mixedIds) } },
                        select: { tmdbId: true, name: true, year: true, lastUpdated: true },
                        orderBy: { lastUpdated: 'desc' }, // 最终排序
                        take: 50
                    });

                    for (const s of seriesList) {
                        const safeNameStr = sanitizeName(s.name);
                        const rowName = `${safeNameStr} (${s.year || 'Unknown'}) {tmdb-${s.tmdbId}}`;
                        // href 必须是 URI 编码的
                        const href = `${basePathForXml}/${encodeURIComponent(rowName)}`;
                        yield genPropXML(href, rowName, true, 0, s.lastUpdated, getYearDate(s.year));
                    }
                }
            } else {
                // 普通分类 (动态计算子分类时间)
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
        
        // === [Level 2] 具体分类浏览 (分页流式) ===
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

                        // 简单的背压释放，防止事件循环阻塞
                        await new Promise(r => setImmediate(r));
                    } catch (err) {
                        console.error(`[WebDAV] Error in category stream ${category}:`, err);
                        // 遇到错误跳出循环，避免无限重试，但已输出的 XML 依然有效
                        hasMore = false;
                    }
                }
            }
        }
        
        // === [Level 3/4] 剧集详情/季详情 ===
        else if (parts.length > 0) {
            const lastPart = parts[parts.length - 1];
            const prevPart = parts.length >= 2 ? parts[parts.length - 2] : null;
            
            const tmdbIdMatch = lastPart ? lastPart.match(/\{tmdb-(\d+)\}/) : null;
            const seasonMatch = lastPart ? lastPart.match(/Season (\d+)/) : null;
            const parentIdMatch = prevPart ? prevPart.match(/\{tmdb-(\d+)\}/) : null;

            // [场景 A] 剧集根目录
            if (tmdbIdMatch && !seasonMatch) {
                const tmdbId = parseInt(tmdbIdMatch[1]);
                
                const seriesInfo = await prisma.seriesMain.findUnique({
                    where: { tmdbId },
                    select: { type: true }
                });

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
                        const totalSize = s._sum.size || 0; 
                        const href = `${basePathForXml}/${encodeURIComponent(seasonName)}`;
                        yield genPropXML(href, seasonName, true, totalSize, lastMod, creation);
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
                    const href = `${basePathForXml}/${encodeURIComponent(f.cleanName)}`;
                    yield genPropXML(href, f.cleanName, false, f.size, f.createdAt, f.createdAt, f.etag);
                    pipelineCacheMeta(pipeline, f, tmdbId);
                }
                pipeline.exec().catch(() => {});
            }
        }
    }

    // 3. 输出 XML 尾部
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
// 7. PROPFIND 处理器 (流式适配)
// ==========================================
async function handlePropfind(req, reply, pathStr, parts) {
    const depth = req.headers['depth'] || '1';
    
    // 1. 预计算文件夹时间戳 (用于 ETag 和 Self Node)
    let folderLastMod = DEFAULT_DATE;

    try {
        if (parts.length === 0) {
             // 根目录：取三者最大
             const [recentEp, movieTime, tvTime] = await Promise.all([
                prisma.seriesEpisode.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
                getCategoryLastMod({ type: 'movie' }),
                getCategoryLastMod({ type: 'tv' })
             ]);
             const recentTime = recentEp?.createdAt || DEFAULT_DATE;
             // 取三者最大值
             const maxTime = Math.max(recentTime.getTime(), movieTime.getTime(), tvTime.getTime());
             folderLastMod = new Date(maxTime);

        } else if (parts.length === 1 && parts[0] === '最近更新') {
             const recentEp = await prisma.seriesEpisode.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
             folderLastMod = recentEp?.createdAt || DEFAULT_DATE;

        } else if (parts.length === 2 && parts[0] !== '最近更新') {
             // 分类目录：查该分类最大时间
             const condition = CATEGORY_MAP[parts[1]];
             if (condition) folderLastMod = await getCategoryLastMod(condition);
        } else {
             // 详情页等：暂用当前时间 (可优化为查详情)
             folderLastMod = new Date();
        }
    } catch(e) {
        console.warn('[WebDAV] Time calc failed, using default', e);
    }

    // 2. 生成 Weak ETag (基于路径 + 时间)
    // 只要 DB 里的时间没变，ETag 就不变，客户端就会走 304
    const pathHash = crypto.createHash('md5').update(pathStr).digest('hex');
    const etagStr = `W/"${pathHash}-${folderLastMod.getTime()}"`;
    
    reply.header('ETag', etagStr);
    if (req.headers['if-none-match'] === etagStr) {
        return reply.code(304).send();
    }

    // 3. 准备流式响应
    // 显式声明 XML 编码，防止客户端乱码
    reply.raw.setHeader('Content-Type', 'application/xml; charset=utf-8');
    reply.raw.setHeader('DAV', '1, 2');
    reply.raw.statusCode = 207; // Multi-Status

    // 4. 发送流
    // 使用 Readable.from 将 Generator 转换为 Node Stream
    const xmlStream = Readable.from(xmlStreamGenerator(pathStr, parts, depth, req, folderLastMod));
    return reply.send(xmlStream);
}

// ==========================================
// 8. GET/HEAD 处理器 (保持不变)
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

// ==========================================
// 9. 辅助处理器 (保持不变)
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
// 10. 缓存管理 (精简版)
// ==========================================
export async function invalidateWebdavCache() {
    try {
        lruCache.clear();
        // 流式模式下主要清理 meta 缓存
        const stream = redis.scanStream({ match: 'webdav:meta:*', count: 100 });
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