// src/webdav-server.js
import { prisma } from './db.js';
import { core123 } from './services/core123.js';
import redis from './redis.js';
import path from 'path';
import crypto from 'crypto';

// ==========================================
// 配置区域
// ==========================================
const WEBDAV_USER = process.env.WEBDAV_USER || "admin";
const WEBDAV_PASSWORD = process.env.WEBDAV_PASSWORD || "password";

// ==========================================
// 缓存策略
// ==========================================
const PREFIX_DIR = 'webdav:dir:';
const PREFIX_META = 'webdav:meta:';
const TTL_DIR = 600;      // 目录缓存 10 分钟
const TTL_META = 3600;    // 文件元数据缓存 1 小时

/**
 * 主动清除 WebDAV 缓存
 */
export async function invalidateWebdavCache() {
    try {
        const stream = redis.scanStream({ match: 'webdav:*', count: 100 });
        stream.on('data', (keys) => {
            if (keys.length) redis.unlink(keys);
        });
        stream.on('end', () => console.log(`[WebDAV] 🧹 Cache cleared`));
    } catch (e) {
        console.error('[WebDAV] Cache clear failed', e);
    }
}

// 分类映射
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
};

// ==========================================
// 工具函数
// ==========================================

// [🔧 路径安全清洗] 防止文件名包含 / 导致 WebDAV 目录死循环
function sanitizeName(name) {
    if (!name) return "Unknown";
    // 将半角斜杠替换为全角，视觉相似但不会破坏 URL 结构
    return String(name).replace(/\//g, '／').replace(/\\/g, '＼');
}

// 计算 ETag (MD5) 用于 304 协商缓存
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

// XML 构建器 (Array Push 模式，高性能)
function appendPropXML(partsArr, href, displayName, isCollection, size = 0, lastMod, etag = "") {
    const dateObj = (lastMod instanceof Date) ? lastMod : new Date(lastMod || 0);
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
    // 这能让资源管理器更快识别文件类型，减少探测
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
                reply.header('MS-Author-Via', 'DAV'); // 增强兼容性
                return reply.send();
            
            // [🛡️ Windows 兼容] 哑巴接口实现
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
    
    // 1. 缓存层 (支持 304 协商)
    const cachedXml = await redis.get(cacheKey);
    if (cachedXml) {
        const etag = calculateETag(cachedXml);
        if (req.headers['if-none-match'] === etag) {
            return reply.code(304).send();
        }
        reply.header('ETag', etag);
        return sendXml(reply, cachedXml);
    }

    // 2. 数据构建
    const xmlParts = [];
    
    // [🔧 路径安全] 强制使用 encodeURIComponent 构建 href，防止路径解析歧义
    // 如果 pathStr 是 "/电影/Face/Off"，parts 是 ["电影", "Face", "Off"] -> 错误
    // 如果 pathStr 是 "/电影/Face／Off"，parts 是 ["电影", "Face／Off"] -> 正确
    // 这里我们重新构建 href 确保它是 URI 编码的
    const encodedPathStr = parts.map(p => encodeURIComponent(p)).join('/');
    const basePathForXml = `/webdav${encodedPathStr ? '/' + encodedPathStr : ''}`;
    const selfName = parts.length > 0 ? parts[parts.length - 1] : '/';
    
    // 添加 Self Entry
    appendPropXML(xmlParts, basePathForXml, selfName, true);

    if (depth !== '0') {
        // Level 0: Root
        if (parts.length === 0) {
            appendPropXML(xmlParts, `${basePathForXml}/电影`, '电影', true);
            appendPropXML(xmlParts, `${basePathForXml}/电视剧`, '电视剧', true);
        }
        
        // Level 1: Categories
        else if (parts.length === 1) {
            const typeFolder = parts[0]; 
            const isMovie = typeFolder === '电影';
            const categories = Object.entries(CATEGORY_MAP);

            for (const [catName, condition] of categories) {
                if ((isMovie && condition.type === 'movie') || (!isMovie && condition.type === 'tv')) {
                    appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(catName)}`, catName, true);
                }
            }
            appendPropXML(xmlParts, `${basePathForXml}/未分类`, '未分类', true);
        }
        
        // Level 2: Series List
        else if (parts.length === 2) {
            const [typeFolder, category] = parts;
            const condition = CATEGORY_MAP[category] || { type: typeFolder === '电影' ? 'movie' : 'tv' };
            
            // [⚡️ DB 瘦身] 仅查询显示列表需要的 4 个字段
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
                // [🔧 路径安全] 清洗数据库中的名称 (如 "Face/Off" -> "Face／Off")
                const safeNameStr = sanitizeName(s.name);
                const folderName = `${safeNameStr} (${s.year || 'Unknown'}) {tmdb-${s.tmdbId}}`;
                appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(folderName)}`, folderName, true, 0, s.lastUpdated);
            }
        }
        
        // Level 3: Files (Movie) or Seasons (TV)
        else if (parts.length === 3) {
            const [typeFolder, category, seriesFolder] = parts;
            const tmdbIdMatch = seriesFolder.match(/\{tmdb-(\d+)\}/);

            if (tmdbIdMatch) {
                const tmdbId = parseInt(tmdbIdMatch[1]);
                const isMovie = typeFolder === '电影';

                if (isMovie) {
                    // [⚡️ DB 瘦身] 仅查询文件列表需要的 4 个核心字段
                    const files = await prisma.seriesEpisode.findMany({ 
                        where: { tmdbId, type: { not: 'subtitle' } },
                        select: { 
                            cleanName: true, 
                            size: true, 
                            createdAt: true, 
                            etag: true 
                        }
                    });
                    for (const f of files) {
                        appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(f.cleanName)}`, f.cleanName, false, Number(f.size), f.createdAt, f.etag);
                        cacheFileMeta(f, tmdbId);
                    }
                } else {
                    const seasons = await prisma.seriesEpisode.groupBy({
                        by: ['season'], 
                        where: { tmdbId, type: { not: 'subtitle' } }, 
                        _count: true
                    });
                    seasons.sort((a, b) => a.season - b.season);

                    for (const s of seasons) {
                        const seasonName = `Season ${String(s.season).padStart(2, '0')}`;
                        appendPropXML(xmlParts, `${basePathForXml}/${encodeURIComponent(seasonName)}`, seasonName, true);
                    }
                }
            }
        }
        
        // Level 4: Episodes (TV)
        else if (parts.length === 4) {
            const [typeFolder, category, seriesFolder, seasonFolder] = parts;
            const tmdbIdMatch = seriesFolder.match(/\{tmdb-(\d+)\}/);
            const seasonMatch = seasonFolder.match(/Season (\d+)/);

            if (tmdbIdMatch && seasonMatch) {
                const tmdbId = parseInt(tmdbIdMatch[1]);
                const season = parseInt(seasonMatch[1]);
                
                // [⚡️ DB 瘦身] 仅查询文件列表需要的 4 个核心字段
                const files = await prisma.seriesEpisode.findMany({
                    where: { tmdbId, season, type: { not: 'subtitle' } }, 
                    select: { 
                        cleanName: true, 
                        size: true, 
                        createdAt: true, 
                        etag: true 
                    },
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
    
    await redis.set(cacheKey, finalXml, 'EX', TTL_DIR);
    
    // 返回带 ETag
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

    // 1. 元数据查询
    const cacheKey = `${PREFIX_META}${tmdbId}:${fileName}`;
    const cachedMetaStr = await redis.get(cacheKey);
    
    let file;
    if (cachedMetaStr) {
        file = JSON.parse(cachedMetaStr);
        file.createdAt = new Date(file.createdAt);
    } else {
        // [⚡️ DB 瘦身] 仅查询获取下载链接和响应头需要的 4 个字段
        file = await prisma.seriesEpisode.findFirst({
            where: { tmdbId, cleanName: fileName },
            select: { 
                cleanName: true, 
                etag: true, 
                size: true, 
                createdAt: true 
            }
        });
        if (file) {
            await redis.set(cacheKey, JSON.stringify(file), 'EX', TTL_META);
        }
    }

    if (!file) return reply.code(404).send('File not found in DB');

    const headers = {
        'Content-Type': getMimeType(fileName),
        'Content-Length': String(file.size),
        'Last-Modified': new Date(file.createdAt).toUTCString(),
        'ETag': `"${file.etag}"`,
        'Accept-Ranges': 'bytes'
    };

    // [⚡️ 性能优化] HEAD 请求直接返回，不触发直链获取
    if (req.method === 'HEAD') {
        reply.headers(headers);
        return reply.send();
    }

    // 2. 获取直链 (仅 GET)
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

// [🛡️ Windows 兼容] 假装成功的 PROPPATCH
function handleDummyProppatch(reply, urlPath) {
    // Windows 试图设置属性时，返回成功或 MultiStatus 207
    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
    <D:response>
        <D:href>${escapeXml(urlPath)}</D:href>
        <D:propstat>
            <D:prop><D:Win32CreationTime/></D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
    </D:response>
</D:multistatus>`;
    return sendXml(reply, xml);
}

// [🛡️ Windows 兼容] 假装成功的 LOCK
function handleDummyLock(req, reply, urlPath) {
    const token = `urn:uuid:${crypto.randomUUID()}`;
    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<D:prop xmlns:D="DAV:">
    <D:lockdiscovery>
        <D:activelock>
            <D:locktype><D:write/></D:locktype>
            <D:lockscope><D:exclusive/></D:lockscope>
            <D:depth>Infinity</D:depth>
            <D:owner><D:href>Unknown</D:href></D:owner>
            <D:timeout>Second-604800</D:timeout>
            <D:locktoken><D:href>${token}</D:href></D:locktoken>
        </D:activelock>
    </D:lockdiscovery>
</D:prop>`;
    
    reply.header('Lock-Token', `<${token}>`);
    return sendXml(reply, xml);
}

function sendXml(reply, xml) {
    return reply.type('application/xml; charset=utf-8').header('DAV', '1, 2').status(207).send(xml);
}

function cacheFileMeta(f, tmdbId) {
    // 异步写入缓存
    const key = `${PREFIX_META}${tmdbId}:${f.cleanName}`;
    const data = { cleanName: f.cleanName, etag: f.etag, size: Number(f.size), createdAt: f.createdAt };
    redis.set(key, JSON.stringify(data), 'EX', TTL_META).catch(() => {});
}