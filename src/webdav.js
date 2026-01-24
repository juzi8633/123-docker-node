// src/webdav-server.js
import { prisma } from './db.js';
import { core123 } from './services/core123.js';
import redis from './redis.js';
import path from 'path';
import crypto from 'crypto'; // [新增] 用于生成 Dummy Lock Token

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
const TTL_DIR = 600;      // [修改] 缩短为 10 分钟，避免元数据长期不更新
const TTL_META = 3600;    // [修改] 文件元数据 1 小时

/**
 * 主动清除 WebDAV 缓存
 */
export async function invalidateWebdavCache() {
    try {
        const stream = redis.scanStream({ match: 'webdav:*', count: 100 });
        let deletedCount = 0;
        stream.on('data', (keys) => {
            if (keys.length) {
                redis.unlink(keys);
                deletedCount += keys.length;
            }
        });
        stream.on('end', () => {
            console.log(`[WebDAV] 🧹 缓存已主动清除 (~${deletedCount} keys)`);
        });
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

// [新增] 路径名称清洗：防止数据库中的名称包含 / 导致 split 路径错误
function sanitizeName(name) {
    if (!name) return "Unknown";
    // 将半角斜杠替换为全角，既保证视觉相似，又不会破坏 URL 结构
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

function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const map = {
        '.mp4': 'video/mp4',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.strm': 'application/vnd.apple.mpegurl',
        '.srt': 'text/plain',
        '.ass': 'text/plain',
        '.vtt': 'text/vtt',
        '.jpg': 'image/jpeg',
        '.png': 'image/png',
        '.nfo': 'text/xml'
    };
    return map[ext] || 'application/octet-stream';
}

function generatePropXML(href, displayName, isCollection, size = 0, lastMod = new Date(), etag = "") {
    const dateObj = (lastMod instanceof Date) ? lastMod : new Date(lastMod || 0);
    // [修正] creationdate 应使用 ISO 8601
    const creation = dateObj.toISOString(); 
    // [修正] lastmodified 应使用 RFC 1123
    const lastModified = dateObj.toUTCString();
    
    let safeHref = escapeXml(href);
    // 规范化：WebDAV 要求集合以 / 结尾
    if (isCollection && !safeHref.endsWith('/')) safeHref += '/';

    const resourceType = isCollection ? "<D:collection/>" : "";
    const contentLength = isCollection ? "" : `<D:getcontentlength>${size}</D:getcontentlength>`;
    const contentType = isCollection ? "" : `<D:getcontenttype>${getMimeType(displayName)}</D:getcontenttype>`;
    // [优化] ETag 添加引号包裹，符合 RFC
    const etagNode = etag ? `<D:getetag>"${etag}"</D:getetag>` : "";
    
    // [新增] Win32 属性支持 (可选，提高 Windows 兼容性)
    // isCollection ? 10 (Directory) : 20 (Archive)
    const fileAttributes = isCollection ? "10" : "20";

    return `
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
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
    </D:response>`;
}

// ==========================================
// 核心请求处理器
// ==========================================
export async function handleWebDavRequest(req, reply) {
    // 1. Basic Auth
    const auth = req.headers['authorization'];
    if (!auth) {
        reply.header('WWW-Authenticate', 'Basic realm="123NodeServer"');
        return reply.code(401).send('Unauthorized');
    }
    const [scheme, encoded] = auth.split(' ');
    if (!/^Basic$/i.test(scheme) || !encoded) return reply.code(400).send('Bad Request');
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user !== WEBDAV_USER || pass !== WEBDAV_PASSWORD) return reply.code(403).send('Forbidden');

    // 2. 路径解析
    // [修正] 移除末尾斜杠可能导致根目录判断错误，需谨慎处理
    let urlPath = decodeURIComponent(req.raw.url.replace(/^\/webdav/, '').split('?')[0]);
    if (urlPath.length > 1 && urlPath.endsWith('/')) urlPath = urlPath.slice(0, -1);
    
    const parts = urlPath.split('/').filter(p => p);
    const method = req.method.toUpperCase();

    try {
        switch (method) {
            case 'PROPFIND':
                return await handlePropfind(req, reply, urlPath, parts);
            case 'GET':
            case 'HEAD':
                return await handleGet(req, reply, urlPath, parts);
            case 'OPTIONS':
                // [新增] 增强的 OPTIONS 头，声明支持 Locking
                reply.header('DAV', '1, 2');
                reply.header('Allow', 'OPTIONS, GET, HEAD, PROPFIND, PROPPATCH, LOCK, UNLOCK');
                reply.header('MS-Author-Via', 'DAV');
                return reply.send();
            
            // [新增] 兼容性：处理 PROPPATCH (Windows 挂载需要)
            case 'PROPPATCH':
                return handleDummyProppatch(reply, urlPath);
            
            // [新增] 兼容性：处理 LOCK (Windows 挂载需要)
            case 'LOCK':
                return handleDummyLock(req, reply, urlPath);
            
            // [新增] 兼容性：处理 UNLOCK
            case 'UNLOCK':
                return reply.code(204).send();

            // [新增] 明确拒绝写入操作
            case 'PUT':
            case 'DELETE':
            case 'MKCOL':
            case 'MOVE':
            case 'COPY':
                return reply.code(403).send('Read-only file system');

            default:
                return reply.code(405).send('Method Not Allowed');
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
    
    const cachedXml = await redis.get(cacheKey);
    if (cachedXml) return sendXml(reply, cachedXml);

    let xmlContent = "";
    const basePath = `/webdav${pathStr === '/' ? '' : pathStr}`;

    // 1. 添加自身 (Self Entry)
    // 注意：如果是根目录，displayName 是 '/'，否则取路径最后一段
    const selfName = parts.length > 0 ? parts[parts.length - 1] : '/';
    xmlContent += generatePropXML(basePath, selfName, true);

    if (depth !== '0') {
        // Level 0: 根目录
        if (parts.length === 0) {
            xmlContent += generatePropXML(`${basePath}/电影`, '电影', true);
            xmlContent += generatePropXML(`${basePath}/电视剧`, '电视剧', true);
        }
        
        // Level 1: 大类 (电影/电视剧)
        else if (parts.length === 1) {
            const typeFolder = parts[0]; 
            const isMovie = typeFolder === '电影';

            for (const [catName, condition] of Object.entries(CATEGORY_MAP)) {
                if ((isMovie && condition.type === 'movie') || (!isMovie && condition.type === 'tv')) {
                    xmlContent += generatePropXML(`${basePath}/${catName}`, catName, true);
                }
            }
            xmlContent += generatePropXML(`${basePath}/未分类`, '未分类', true);
        }
        
        // Level 2: 具体分类 -> 剧集/电影名
        else if (parts.length === 2) {
            const [typeFolder, category] = parts;
            const condition = CATEGORY_MAP[category] || { type: typeFolder === '电影' ? 'movie' : 'tv' };
            
            const seriesList = await prisma.seriesMain.findMany({
                where: condition,
                select: { tmdbId: true, name: true, year: true, lastUpdated: true },
                orderBy: { lastUpdated: 'desc' }
            });

            for (const s of seriesList) {
                // [安全处理] 使用 sanitizeName 处理显示名称
                const safeNameStr = sanitizeName(s.name);
                const folderName = `${safeNameStr} (${s.year || 'Unknown'}) {tmdb-${s.tmdbId}}`;
                
                // 必须对路径部分进行 URI 编码
                xmlContent += generatePropXML(`${basePath}/${encodeURIComponent(folderName)}`, folderName, true, 0, s.lastUpdated);
            }
        }
        
        // Level 3: 剧集/电影目录 -> 季 或 文件
        else if (parts.length === 3) {
            const [typeFolder, category, seriesFolder] = parts;
            // 依赖 ID 匹配，不受名称清洗影响
            const tmdbIdMatch = seriesFolder.match(/\{tmdb-(\d+)\}/);

            if (tmdbIdMatch) {
                const tmdbId = parseInt(tmdbIdMatch[1]);
                const isMovie = typeFolder === '电影';

                if (isMovie) {
                    const files = await prisma.seriesEpisode.findMany({ 
                        where: { tmdbId, type: { not: 'subtitle' } } 
                    });
                    for (const f of files) {
                        xmlContent += generatePropXML(
                            `${basePath}/${encodeURIComponent(f.cleanName)}`,
                            f.cleanName, // 文件名通常是 clean 的，暂不 sanitize
                            false, 
                            Number(f.size), 
                            f.createdAt, 
                            f.etag
                        );
                        cacheFileMeta(f); 
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
                        xmlContent += generatePropXML(`${basePath}/${encodeURIComponent(seasonName)}`, seasonName, true);
                    }
                }
            }
        }
        
        // Level 4: Season -> 分集
        else if (parts.length === 4) {
            const [typeFolder, category, seriesFolder, seasonFolder] = parts;
            const tmdbIdMatch = seriesFolder.match(/\{tmdb-(\d+)\}/);
            const seasonMatch = seasonFolder.match(/Season (\d+)/);

            if (tmdbIdMatch && seasonMatch) {
                const tmdbId = parseInt(tmdbIdMatch[1]);
                const season = parseInt(seasonMatch[1]);
                
                const files = await prisma.seriesEpisode.findMany({
                    where: { tmdbId, season, type: { not: 'subtitle' } }, 
                    orderBy: { episode: 'asc' }
                });

                for (const f of files) {
                    xmlContent += generatePropXML(
                        `${basePath}/${encodeURIComponent(f.cleanName)}`,
                        f.cleanName, 
                        false, 
                        Number(f.size), 
                        f.createdAt, 
                        f.etag
                    );
                    cacheFileMeta(f);
                }
            }
        }
    }

    const finalXml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${xmlContent}</D:multistatus>`;
    await redis.set(cacheKey, finalXml, 'EX', TTL_DIR);
    return sendXml(reply, finalXml);
}

async function handleGet(req, reply, pathStr, parts) {
    const fileName = decodeURIComponent(parts[parts.length - 1]);
    
    // 1. 尝试从路径中提取 TMDB ID (递归向上查找)
    let tmdbId = null;
    const pathMatch = pathStr.match(/\{tmdb-(\d+)\}/);
    if (pathMatch) tmdbId = parseInt(pathMatch[1]);

    if (!tmdbId) return reply.code(404).send('File context not found');

    // 2. 查找文件元数据 (优先查 Redis)
    const cacheKey = `${PREFIX_META}${tmdbId}:${fileName}`;
    const cachedMetaStr = await redis.get(cacheKey);
    
    let file;
    if (cachedMetaStr) {
        file = JSON.parse(cachedMetaStr);
        file.createdAt = new Date(file.createdAt);
    } else {
        file = await prisma.seriesEpisode.findFirst({
            where: { tmdbId, cleanName: fileName },
            select: { cleanName: true, etag: true, size: true, createdAt: true }
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

    // [优化] HEAD 请求直接返回，不触发后端直链获取逻辑
    if (req.method === 'HEAD') {
        reply.headers(headers);
        return reply.send();
    }

    // 3. 获取下载直链 (仅 GET)
    try {
        const downloadUrl = await core123.getDownloadUrlByHash(file.cleanName, file.etag, Number(file.size));
        
        if (!downloadUrl) throw new Error('Link generation failed');

        req.log.info({ file: fileName, ip: req.ip }, `[WebDAV] Redirecting stream`);
        return reply.redirect(downloadUrl);
    } catch (e) {
        req.log.error(e, `[WebDAV] Failed to get link for ${fileName}`);
        return reply.code(502).send('Upstream Error');
    }
}

// [新增] 假装成功的 PROPPATCH (欺骗 Windows)
function handleDummyProppatch(reply, urlPath) {
    // 返回 MultiStatus 告诉客户端 "属性设置失败/忽略，但我收到了" 或者直接返回 "OK"
    // 最简单的欺骗是告诉它设置成功了，或者对应的属性 403 但整体 207
    // 这里使用一个通用的成功模板
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

// [新增] 假装成功的 LOCK (欺骗 Windows)
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
    return reply
        .type('application/xml; charset=utf-8')
        .header('DAV', '1, 2')
        .status(207)
        .send(xml);
}

async function cacheFileMeta(f) {
    const key = `${PREFIX_META}${f.tmdbId}:${f.cleanName}`;
    const data = { 
        cleanName: f.cleanName, 
        etag: f.etag, 
        size: Number(f.size), 
        createdAt: f.createdAt 
    };
    // 异步写入缓存，不阻塞
    redis.set(key, JSON.stringify(data), 'EX', TTL_META).catch(e => console.error(e));
}