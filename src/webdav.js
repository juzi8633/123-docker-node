// src/webdav-server.js
import { prisma } from './db.js';
import { core123 } from './services/core123.js';
import redis from './redis.js';
import path from 'path';

// ==========================================
// 配置区域
// ==========================================
const WEBDAV_USER = process.env.WEBDAV_USER || "admin";
const WEBDAV_PASSWORD = process.env.WEBDAV_PASSWORD || "password";
// 虚拟空间设置为 100TB，防止客户端报空间不足错误
const VIRTUAL_QUOTA = 100 * 1024 * 1024 * 1024 * 1024; 

// ==========================================
// 缓存策略 (高性能模式)
// ==========================================
const PREFIX_DIR = 'webdav:dir:';
const PREFIX_META = 'webdav:meta:';

// [优化] 缓存时间延长至 7 天 (604800秒)
// 依赖 "主动清除" 机制来保证数据实时性，大幅降低数据库空闲负载
const TTL_DIR = 604800;   
const TTL_META = 604800; 

/**
 * 主动清除 WebDAV 缓存
 * 当有文件上传、删除、元数据变更时调用
 */
export async function invalidateWebdavCache() {
    try {
        // 使用 scanStream 流式删除，避免在 key 数量巨大时阻塞 Redis 主线程
        const stream = redis.scanStream({ match: 'webdav:*', count: 100 });
        let deletedCount = 0;
        
        stream.on('data', (keys) => {
            if (keys.length) {
                // unlink 是 del 的异步非阻塞版本，更推荐
                redis.unlink(keys);
                deletedCount += keys.length;
            }
        });
        
        stream.on('end', () => {
            console.log(`[WebDAV] 🧹 缓存已主动清除 (Invalidation Triggered, ~${deletedCount} keys)`);
        });
    } catch (e) {
        console.error('[WebDAV] Cache clear failed', e);
    }
}

// 对应 strm.js 的分类逻辑映射
// 确保 WebDAV 目录结构与物理 STRM 目录完全一致
const CATEGORY_MAP = {
    // 电影
    '华语电影': { type: 'movie', OR: [{ originalLanguage: 'zh' }, { originalLanguage: 'cn' }] },
    '外语电影': { type: 'movie', NOT: [{ originalLanguage: 'zh' }, { originalLanguage: 'cn' }] },
    '动画电影': { type: 'movie', genres: { contains: '16' } },
    
    // 剧集
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
// XML 生成工具
// ==========================================
function escapeXml(unsafe) {
    if (!unsafe) return "";
    return String(unsafe).replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case "<": return "&lt;"; case ">": return "&gt;"; case "&": return "&amp;"; case "'": return "&apos;"; case '"': return "&quot;";
        }
    });
}

function generatePropXML(href, displayName, isCollection, size = 0, lastMod = new Date(), etag = "") {
    // 容错处理：Redis 取出的 lastMod 可能是字符串
    const dateObj = (lastMod instanceof Date) ? lastMod : new Date(lastMod || 0);
    
    const creation = dateObj.toISOString().split('.')[0] + 'Z';
    const lastModified = dateObj.toUTCString();
    
    // 针对 Infuse/VidHub 优化 Content-Type
    const contentType = isCollection ? "" : `<D:getcontenttype>video/mp4</D:getcontenttype>`;
    
    // 目录不返回大小
    const contentLength = isCollection ? "" : `<D:getcontentlength>${size}</D:getcontentlength>`;
    const resourceType = isCollection ? "<D:collection/>" : "";
    const etagNode = etag ? `<D:getetag>"${etag}"</D:getetag>` : "";
    
    // 仅根目录返回 Quota，减少 XML 体积
    const quota = (href === '/webdav/') ? `<D:quota-available-bytes>${VIRTUAL_QUOTA}</D:quota-available-bytes>` : "";

    return `
    <D:response>
        <D:href>${escapeXml(href)}</D:href>
        <D:propstat>
            <D:prop>
                <D:displayname>${escapeXml(displayName)}</D:displayname>
                <D:resourcetype>${resourceType}</D:resourcetype>
                <D:creationdate>${creation}</D:creationdate>
                <D:getlastmodified>${lastModified}</D:getlastmodified>
                ${contentLength}
                ${contentType}
                ${etagNode}
                ${quota}
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
        </D:propstat>
    </D:response>`;
}

// ==========================================
// 核心请求处理器
// ==========================================
export async function handleWebDavRequest(req, reply) {
    // 1. Basic Auth 鉴权
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
    // 移除前缀 /webdav，并将 URL 解码
    // 例如: /webdav/电影/华语电影 -> /电影/华语电影
    let urlPath = decodeURIComponent(req.raw.url.replace(/^\/webdav/, '').split('?')[0]);
    // 去除末尾斜杠 (除非是根目录)
    if (urlPath.length > 1 && urlPath.endsWith('/')) urlPath = urlPath.slice(0, -1);
    const parts = urlPath.split('/').filter(p => p);
    
    const method = req.method.toUpperCase();

    try {
        if (method === 'PROPFIND') return await handlePropfind(req, reply, urlPath, parts);
        if (method === 'GET' || method === 'HEAD') return await handleGet(req, reply, urlPath, parts);
        if (method === 'OPTIONS') {
            reply.header('DAV', '1, 2');
            reply.header('Allow', 'OPTIONS, GET, HEAD, PROPFIND');
            return reply.send();
        }
        return reply.code(405).send('Method Not Allowed');
    } catch (e) {
        req.log.error(e, `[WebDAV] Error handling ${urlPath}`);
        return reply.code(500).send('Internal Server Error');
    }
}

// 处理目录列表 (PROPFIND)
async function handlePropfind(req, reply, pathStr, parts) {
    const depth = req.headers['depth'] || '1';
    const cacheKey = `${PREFIX_DIR}${pathStr}:${depth}`;
    
    // [Cache Check]
    const cachedXml = await redis.get(cacheKey);
    if (cachedXml) {
        return sendXml(reply, cachedXml);
    }

    let xmlContent = "";
    
    // Level 0: 根目录
    if (parts.length === 0) {
        xmlContent += generatePropXML('/webdav/', 'Root', true);
        if (depth !== '0') {
            xmlContent += generatePropXML('/webdav/电影/', '电影', true);
            xmlContent += generatePropXML('/webdav/电视剧/', '电视剧', true);
        }
    }
    // Level 1: 电影/电视剧 根目录
    else if (parts.length === 1) {
        const typeFolder = parts[0]; 
        const isMovie = typeFolder === '电影';
        const currentHref = `/webdav/${typeFolder}`;
        xmlContent += generatePropXML(currentHref, typeFolder, true);

        if (depth !== '0') {
            // 纯内存遍历，极快
            for (const [catName, condition] of Object.entries(CATEGORY_MAP)) {
                // 根据类型过滤
                if ((isMovie && condition.type === 'movie') || (!isMovie && condition.type === 'tv')) {
                    xmlContent += generatePropXML(`${currentHref}/${catName}/`, catName, true);
                }
            }
            // 兜底分类
            xmlContent += generatePropXML(`${currentHref}/未分类/`, '未分类', true);
        }
    }
    // Level 2: 具体分类目录 (关键性能点)
    else if (parts.length === 2) {
        const [typeFolder, category] = parts;
        const currentHref = `/webdav/${typeFolder}/${category}`;
        xmlContent += generatePropXML(currentHref, category, true);

        if (depth !== '0') {
            const condition = CATEGORY_MAP[category] || { type: typeFolder === '电影' ? 'movie' : 'tv' };
            
            // [核心修正] 移除 take 限制，支持海量数据
            // 只查询必要字段，减少内存与网络开销
            const seriesList = await prisma.seriesMain.findMany({
                where: condition,
                select: { tmdbId: true, name: true, year: true, lastUpdated: true },
                orderBy: { lastUpdated: 'desc' },
                // take: 500 // <--- 已移除
            });

            for (const s of seriesList) {
                const folderName = `${s.name} (${s.year || 'Unknown'}) {tmdb-${s.tmdbId}}`;
                xmlContent += generatePropXML(`${currentHref}/${encodeURIComponent(folderName)}/`, folderName, true, 0, s.lastUpdated);
            }
        }
    }
    // Level 3: 剧集/电影 具体目录
    else if (parts.length === 3) {
        const [typeFolder, category, seriesFolder] = parts;
        const tmdbIdMatch = seriesFolder.match(/\{tmdb-(\d+)\}/);
        const currentHref = `/webdav/${pathStr}`;
        
        xmlContent += generatePropXML(currentHref, seriesFolder, true);

        if (depth !== '0' && tmdbIdMatch) {
            const tmdbId = parseInt(tmdbIdMatch[1]);
            const isMovie = typeFolder === '电影';

            if (isMovie) {
                // 电影：直接列出文件
                const files = await prisma.seriesEpisode.findMany({ 
                    where: { tmdbId, type: { not: 'subtitle' } } 
                });
                for (const f of files) {
                    xmlContent += generatePropXML(
                        `${currentHref}/${encodeURIComponent(f.cleanName)}`,
                        f.cleanName, 
                        false, 
                        Number(f.size), 
                        f.createdAt, 
                        f.etag
                    );
                    // 异步预热文件元数据缓存
                    cacheFileMeta(f); 
                }
            } else {
                // 电视剧：列出 Season 目录
                // 使用 groupBy 聚合查询，比 distinct 快
                const seasons = await prisma.seriesEpisode.groupBy({
                    by: ['season'], 
                    where: { tmdbId, type: { not: 'subtitle' } }, 
                    _count: true
                });
                
                // 排序 Season
                seasons.sort((a, b) => a.season - b.season);

                for (const s of seasons) {
                    const seasonName = `Season ${String(s.season).padStart(2, '0')}`;
                    xmlContent += generatePropXML(`${currentHref}/${encodeURIComponent(seasonName)}/`, seasonName, true);
                }
            }
        }
    }
    // Level 4: Season 目录 (仅 TV)
    else if (parts.length === 4) {
        const [typeFolder, category, seriesFolder, seasonFolder] = parts;
        const tmdbIdMatch = seriesFolder.match(/\{tmdb-(\d+)\}/);
        const seasonMatch = seasonFolder.match(/Season (\d+)/);
        const currentHref = `/webdav/${pathStr}`;
        
        xmlContent += generatePropXML(currentHref, seasonFolder, true);

        if (depth !== '0' && tmdbIdMatch && seasonMatch) {
            const tmdbId = parseInt(tmdbIdMatch[1]);
            const season = parseInt(seasonMatch[1]);
            
            const files = await prisma.seriesEpisode.findMany({
                where: { tmdbId, season, type: { not: 'subtitle' } }, 
                orderBy: { episode: 'asc' }
            });

            for (const f of files) {
                xmlContent += generatePropXML(
                    `${currentHref}/${encodeURIComponent(f.cleanName)}`,
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

    const finalXml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${xmlContent}</D:multistatus>`;
    
    // [Redis] 写入 7 天缓存
    await redis.set(cacheKey, finalXml, 'EX', TTL_DIR);
    
    return sendXml(reply, finalXml);
}

// 处理文件获取 (GET/HEAD)
async function handleGet(req, reply, pathStr, parts) {
    const fileName = decodeURIComponent(parts[parts.length - 1]);
    
    // 1. 尝试从路径中提取 TMDB ID (无需正则匹配整个路径，只找ID特征)
    let tmdbId = null;
    const pathMatch = pathStr.match(/\{tmdb-(\d+)\}/);
    if (pathMatch) tmdbId = parseInt(pathMatch[1]);

    if (!tmdbId) return reply.code(404).send('File context not found');

    // 2. 查找文件元数据
    // [Redis] 优先查 Redis
    const cacheKey = `${PREFIX_META}${tmdbId}:${fileName}`;
    const cachedMetaStr = await redis.get(cacheKey);
    
    let file;
    if (cachedMetaStr) {
        file = JSON.parse(cachedMetaStr);
        // Redis 存的是字符串，转回 Date
        file.createdAt = new Date(file.createdAt);
    } else {
        // [DB] Redis 未命中，查库
        file = await prisma.seriesEpisode.findFirst({
            where: { tmdbId, cleanName: fileName },
            select: { cleanName: true, etag: true, size: true, createdAt: true }
        });
        if (file) {
            // 写入缓存
            await redis.set(cacheKey, JSON.stringify(file), 'EX', TTL_META);
        }
    }

    if (!file) return reply.code(404).send('File not found in DB');

    // 3. 构造响应头
    const headers = {
        'Content-Type': 'video/mp4', // 简化处理
        'Content-Length': String(file.size),
        'Last-Modified': new Date(file.createdAt).toUTCString(),
        'ETag': `"${file.etag}"`,
        'Accept-Ranges': 'bytes'
    };

    if (req.method === 'HEAD') {
        reply.headers(headers);
        return reply.send();
    }

    // 4. 获取下载直链 (GET)
    try {
        // core123 内部也有缓存，这里获取速度很快
        const downloadUrl = await core123.getDownloadUrlByHash(file.cleanName, file.etag, Number(file.size));
        
        if (!downloadUrl) throw new Error('Link generation failed');

        req.log.info({ file: fileName, ip: req.ip }, `[WebDAV] Redirecting stream`);
        return reply.redirect(downloadUrl);
    } catch (e) {
        req.log.error(e, `[WebDAV] Failed to get link for ${fileName}`);
        return reply.code(502).send('Upstream Error');
    }
}

function sendXml(reply, xml) {
    return reply
        .type('application/xml; charset=utf-8')
        .header('DAV', '1, 2')
        .status(207)
        .send(xml);
}

// 辅助：异步缓存文件元数据
async function cacheFileMeta(f) {
    const key = `${PREFIX_META}${f.tmdbId}:${f.cleanName}`;
    const data = { 
        cleanName: f.cleanName, 
        etag: f.etag, 
        size: Number(f.size), 
        createdAt: f.createdAt 
    };
    redis.set(key, JSON.stringify(data), 'EX', TTL_META).catch(e => console.error(e));
}