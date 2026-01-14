import { prisma } from './db.js';
import { core123 } from './services/core123.js';

// ==========================================
// 1. 高级缓存与配置系统
// ==========================================
const CONFIG = {
    XML_NS: 'xmlns:D="DAV:"',
    DEFAULT_DATE: new Date("2024-01-01T00:00:00Z"),
    VIRTUAL_QUOTA: 10 * 1024 * 1024 * 1024 * 1024 * 1024, // 10PB
    CACHE_TTL: {
        META: 300 * 1000,    // 文件元数据缓存 5分钟 (配合PROPFIND预热)
        LINK: 3600 * 1000    // 直链缓存 1小时
    }
};

const TMDB_GENRES = {
    0:'未分类', 28: "动作", 12: "冒险", 16: "动画", 35: "喜剧", 80: "犯罪", 
    99: "纪录", 18: "剧情", 10751: "家庭", 14: "奇幻", 36: "历史", 
    27: "恐怖", 10402: "音乐", 9648: "悬疑", 10749: "爱情", 878: "科幻", 
    10770: "电视电影", 53: "惊悚", 10752: "战争", 37: "西部"
};
// 预处理分类映射
const GENRE_NAME_TO_ID = Object.fromEntries(Object.entries(TMDB_GENRES).map(([k, v]) => [v, k]));
const STATIC_GENRES_LIST = Object.values(TMDB_GENRES).sort((a, b) => a.localeCompare(b, 'zh-CN'));

const ALLOWED_EXTS = new Set([
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "iso", "rmvb", "mpg", "mpeg", "srt", "ass", "ssa", "vtt"
]);

// --- 内存缓存系统 (LRU 简化版) ---
class MemoryCache {
    constructor(limit = 10000) {
        this.cache = new Map();
        this.limit = limit;
    }
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }
        return item.value;
    }
    set(key, value, ttlMs) {
        if (this.cache.size >= this.limit) {
            // 简单的清理策略：删掉第一个（最旧的）
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, { value, expiry: Date.now() + ttlMs });
    }
}

// 缓存实例
const FILE_META_CACHE = new MemoryCache(5000); // 存放 PROPFIND 查到的文件信息
const LINK_CACHE = new MemoryCache(1000);      // 存放已解析的 123pan 直链
const PENDING_REQUESTS = new Map();            // 请求合并锁

// ==========================================
// 2. 核心工具函数
// ==========================================
const Utils = {
    escapeXml: (str) => {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");
    },
    
    // 统一日期格式化
    fmtDate: (d, type = 'iso') => {
        const date = d ? new Date(d) : CONFIG.DEFAULT_DATE;
        const validDate = isNaN(date.getTime()) ? CONFIG.DEFAULT_DATE : date;
        if (type === 'http') return validDate.toUTCString();
        // ISO remove millis for nicer looking XML
        return validDate.toISOString().split('.')[0] + 'Z';
    },

    extractTmdbId: (name) => {
        const match = name && name.match(/\{tmdbid-(\d+)\}/i);
        return match ? parseInt(match[1]) : null;
    },

    checkAuth: (req) => {
        const auth = req.headers['authorization'];
        if (!auth) return false;
        // 建议改为从 process.env 获取
        const [scheme, encoded] = auth.split(' ');
        if (!/^Basic$/i.test(scheme)) return false;
        const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
        return u === (process.env.WEBDAV_USER || 'admin') && 
               p === (process.env.WEBDAV_PASSWORD || 'password123');
    }
};

// ==========================================
// 3. 智能直链获取 (含防击穿与预加载)
// ==========================================
async function getOrFetchLink(fileMeta) {
    const cacheKey = `link:${fileMeta.tmdbId}:${fileMeta.etag}`;
    
    // 1. 查缓存
    const cached = LINK_CACHE.get(cacheKey);
    if (cached) return cached;

    // 2. 查是否正在请求中 (请求合并)
    if (PENDING_REQUESTS.has(cacheKey)) {
        return PENDING_REQUESTS.get(cacheKey);
    }

    // 3. 发起新请求
    const promise = (async () => {
        try {
            console.log(`[API] Fetching link for: ${fileMeta.cleanName}`);
            const url = await core123.getDownloadUrlByHash(
                fileMeta.cleanName, 
                fileMeta.etag, 
                Number(fileMeta.size)
            );
            if (url) {
                LINK_CACHE.set(cacheKey, url, CONFIG.CACHE_TTL.LINK);
            }
            return url;
        } catch (e) {
            console.error(`[API Error] ${fileMeta.cleanName}:`, e.message);
            return null;
        } finally {
            PENDING_REQUESTS.delete(cacheKey);
        }
    })();

    PENDING_REQUESTS.set(cacheKey, promise);
    return promise;
}

// 后台预加载下一集 (Fire and Forget)
function tryPrefetchNextEpisode(currentFileMeta) {
    // 仅针对剧集
    if (!currentFileMeta.season || !currentFileMeta.episode) return;
    
    // 异步执行，不阻塞主线程
    setImmediate(async () => {
        try {
            const nextEpNum = currentFileMeta.episode + 1;
            // 查库找下一集
            const nextEp = await prisma.seriesEpisode.findFirst({
                where: {
                    tmdbId: currentFileMeta.tmdbId,
                    season: currentFileMeta.season,
                    episode: nextEpNum,
                    type: { not: 'subtitle' }
                },
                select: { cleanName: true, etag: true, size: true, tmdbId: true }
            });
            
            if (nextEp) {
                // 触发获取逻辑，结果会存入 LINK_CACHE
                console.log(`[Prefetch] Triggering next episode: S${nextEp.season}E${nextEpNum}`);
                await getOrFetchLink(nextEp);
            }
        } catch (e) {
            // 预加载失败静默处理
        }
    });
}

// ==========================================
// 4. XML 响应生成器
// ==========================================
function sendXml(reply, xmlContent) {
    reply.raw.writeHead(207, {
        'Content-Type': 'application/xml; charset=utf-8',
        'DAV': '1, 2'
    });
    reply.raw.write(`<?xml version="1.0" encoding="utf-8" ?><D:multistatus ${CONFIG.XML_NS}>`);
    reply.raw.write(xmlContent);
    reply.raw.write('</D:multistatus>');
    reply.raw.end();
}

function buildNodeXml(node) {
    const isDir = node.type === "collection";
    const href = Utils.escapeXml(node.href);
    const name = Utils.escapeXml(node.displayName);
    const cDate = Utils.fmtDate(node.lastMod || node.createdAt);
    const mDate = Utils.fmtDate(node.lastMod || node.createdAt, 'http');
    
    // ETag 生成逻辑
    const etag = node.etag ? `"${node.etag}"` : `"${new Date(node.lastMod || CONFIG.DEFAULT_DATE).getTime().toString(16)}"`;

    let props = `
        <D:displayname>${name}</D:displayname>
        <D:creationdate>${cDate}</D:creationdate>
        <D:getlastmodified>${mDate}</D:getlastmodified>
        <D:getetag>${etag}</D:getetag>
        <D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>
    `;

    if (isDir) {
        props += `<D:quota-available-bytes>${CONFIG.VIRTUAL_QUOTA}</D:quota-available-bytes>`;
    } else {
        props += `
            <D:getcontentlength>${node.size || 0}</D:getcontentlength>
            <D:getcontenttype>application/octet-stream</D:getcontenttype>
        `;
    }

    return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

// ==========================================
// 5. 主处理逻辑
// ==========================================
export async function handleWebDav(req, reply) {
    if (!Utils.checkAuth(req)) {
        reply.header('WWW-Authenticate', 'Basic realm="WebDAV"');
        return reply.code(401).send('Unauthorized');
    }

    // 路径处理
    const prefix = '/webdav';
    let path = decodeURIComponent(req.raw.url.split('?')[0]);
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    if (!path.startsWith('/')) path = '/' + path;

    const parts = path.split('/').filter(Boolean);
    const method = req.method.toUpperCase();

    try {
        if (method === 'OPTIONS') {
            return reply.headers({
                "DAV": "1, 2",
                "Allow": "OPTIONS, GET, HEAD, PROPFIND",
                "MS-Author-Via": "DAV"
            }).send();
        }

        if (method === 'PROPFIND') {
            return await handlePropfind(req, reply, parts, prefix);
        }

        if (method === 'GET' || method === 'HEAD') {
            return await handleGetHead(req, reply, parts, method);
        }

        return reply.code(405).send('Method Not Allowed');
    } catch (e) {
        console.error("WebDAV Critical Error:", e);
        return reply.code(500).send("Internal Server Error");
    }
}

// --- PROPFIND 处理器 ---
async function handlePropfind(req, reply, parts, prefix) {
    const depth = req.headers['depth'] || "1";
    const selfHref = prefix + parts.map(encodeURIComponent).join('/') + (parts.length > 0 ? '/' : '');
    let xml = "";

    // 0. 总是添加自身
    xml += buildNodeXml({
        href: selfHref,
        displayName: parts.length > 0 ? parts[parts.length-1] : "Root",
        type: "collection",
        lastMod: CONFIG.DEFAULT_DATE
    });

    if (depth !== "0") {
        const pUrl = selfHref.endsWith('/') ? selfHref : selfHref + '/';

        // Level 0: 根目录
        if (parts.length === 0) {
            xml += buildNodeXml({ href: `${pUrl}%E7%94%B5%E5%BD%B1/`, displayName: "电影", type: "collection" });
            xml += buildNodeXml({ href: `${pUrl}%E5%89%A7%E9%9B%86/`, displayName: "剧集", type: "collection" });
        }

        // Level 1: 分类
        else if (parts.length === 1) {
            const dbType = parts[0] === "电影" ? "movie" : "tv";
            // 批量查询分类时间 (优化)
            const keys = STATIC_GENRES_LIST.map(g => `genre:${dbType}:${GENRE_NAME_TO_ID[g]}`);
            let metaMap = {}; 
            try {
                // 安全的做法：使用 Prisma raw 查询
                const metas = await prisma.folder_meta.findMany({
                    where: { key: { in: keys } }
                });
                metas.forEach(m => metaMap[m.key] = m.last_updated);
            } catch(e) {} // 忽略表不存在错误

            for (const g of STATIC_GENRES_LIST) {
                const key = `genre:${dbType}:${GENRE_NAME_TO_ID[g]}`;
                xml += buildNodeXml({
                    href: `${pUrl}${encodeURIComponent(g)}/`,
                    displayName: g,
                    type: "collection",
                    lastMod: metaMap[key] || CONFIG.DEFAULT_DATE
                });
            }
        }

        // Level 2: 年份
        else if (parts.length === 2) {
            const [typeStr, genreName] = parts;
            const dbType = typeStr === "电影" ? "movie" : "tv";
            const genreId = parseInt(GENRE_NAME_TO_ID[genreName]);

            if (genreId) {
                const years = await prisma.$queryRaw`
                    SELECT year FROM stats_genre_years 
                    WHERE genre_id = ${genreId} AND type = ${dbType} 
                    ORDER BY year DESC
                `;
                for (const r of years) {
                    xml += buildNodeXml({
                        href: `${pUrl}${r.year}/`,
                        displayName: String(r.year),
                        type: "collection"
                    });
                }
            }
        }

        // Level 3: 剧集/电影名
        else if (parts.length === 3) {
            const [typeStr, genreName, yearStr] = parts;
            const dbType = typeStr === "电影" ? "movie" : "tv";
            const genreId = parseInt(GENRE_NAME_TO_ID[genreName]);
            const year = parseInt(yearStr);

            if (genreId && year) {
                const list = await prisma.$queryRaw`
                    SELECT m.tmdb_id, m.name, m.last_updated 
                    FROM series_main m 
                    JOIN series_genres g ON m.tmdb_id = g.tmdb_id AND m.type = g.type
                    WHERE m.type = ${dbType} AND g.genre_id = ${genreId} AND m.year = ${year}
                    ORDER BY m.last_updated DESC
                `;
                for (const row of list) {
                    const dirName = `${row.name} {tmdbid-${row.tmdb_id}}`;
                    xml += buildNodeXml({
                        href: `${pUrl}${encodeURIComponent(dirName)}/`,
                        displayName: dirName,
                        type: "collection",
                        lastMod: row.last_updated
                    });
                }
            }
        }

        // Level 4+: 具体文件
        else if (parts.length >= 4) {
            const tmdbId = Utils.extractTmdbId(parts[3]);
            const dbType = parts[0] === "电影" ? "movie" : "tv";

            if (tmdbId) {
                let files = [];
                // 电影: 直接列出
                if (dbType === "movie") {
                    files = await prisma.seriesEpisode.findMany({
                        where: { tmdbId, type: { not: 'subtitle' } },
                        select: { cleanName: true, size: true, createdAt: true, etag: true, tmdbId: true }
                    });
                } 
                // 剧集: 处理 Season 文件夹
                else {
                    if (parts.length === 4) {
                        const seasons = await prisma.seriesEpisode.groupBy({
                            by: ['season'],
                            where: { tmdbId },
                            orderBy: { season: 'asc' }
                        });
                        for (const s of seasons) {
                            xml += buildNodeXml({
                                href: `${pUrl}Season%20${s.season}/`,
                                displayName: `Season ${s.season}`,
                                type: "collection"
                            });
                        }
                    } else if (parts.length === 5) {
                        const seasonNum = parseInt(parts[4].replace(/season\s*/i, ''));
                        if (!isNaN(seasonNum)) {
                            files = await prisma.seriesEpisode.findMany({
                                where: { tmdbId, season: seasonNum, type: { not: 'subtitle' } },
                                orderBy: [{ episode: 'asc' }, { cleanName: 'asc' }],
                                // 多选几个字段用于缓存
                                select: { cleanName: true, size: true, createdAt: true, etag: true, tmdbId: true, season: true, episode: true }
                            });
                        }
                    }
                }

                // 遍历文件生成XML并 [预热缓存]
                for (const f of files) {
                    const ext = f.cleanName.split('.').pop().toLowerCase();
                    if (!ALLOWED_EXTS.has(ext)) continue;

                    // === [关键优化] 写入 Hot Cache ===
                    // 这样接下来的 HEAD/GET 请求直接命中内存
                    FILE_META_CACHE.set(`meta:${tmdbId}:${f.cleanName}`, f, CONFIG.CACHE_TTL.META);

                    xml += buildNodeXml({
                        href: `${pUrl}${encodeURIComponent(f.cleanName)}`,
                        displayName: f.cleanName,
                        type: "resource",
                        size: Number(f.size),
                        lastMod: f.createdAt,
                        etag: f.etag
                    });
                }
            }
        }
    }
    
    sendXml(reply, xml);
}

// --- GET/HEAD 处理器 ---
async function handleGetHead(req, reply, parts, method) {
    const fileName = decodeURIComponent(parts[parts.length - 1]);
    const ext = fileName.split('.').pop().toLowerCase();
    
    if (!ALLOWED_EXTS.has(ext)) return reply.code(404).send('Blocked');
    const tmdbId = parts.length >= 4 ? Utils.extractTmdbId(parts[3]) : null;
    if (!tmdbId) return reply.code(404).send('No Context');

    // 1. [关键优化] 优先查 Hot Cache (来自 PROPFIND 的预热)
    let fileMeta = FILE_META_CACHE.get(`meta:${tmdbId}:${fileName}`);

    // 2. 缓存未命中（例如直接访问链接，没走目录），回源查库
    if (!fileMeta) {
        fileMeta = await prisma.seriesEpisode.findFirst({
            where: { tmdbId, cleanName: fileName },
            select: { cleanName: true, etag: true, size: true, createdAt: true, tmdbId: true, season: true, episode: true }
        });
    }

    if (!fileMeta) return reply.code(404).send('Not Found');

    // 处理 HEAD 请求
    if (method === 'HEAD') {
        reply.headers({
            "Content-Type": "application/octet-stream",
            "Content-Length": fileMeta.size.toString(),
            "Last-Modified": Utils.fmtDate(fileMeta.createdAt, 'http'),
            "ETag": `"${fileMeta.etag}"`,
            "Accept-Ranges": "bytes"
        });
        
        // [关键优化] HEAD 请求意味着用户可能马上要播放
        // 在后台悄悄开始解析直链 (预热 Link Cache)
        getOrFetchLink(fileMeta).catch(err => console.error("Prewarm failed", err));
        
        return reply.code(200).send();
    }

    // 处理 GET 请求
    try {
        // [关键优化] 智能获取直链（含合并请求逻辑）
        const downloadUrl = await getOrFetchLink(fileMeta);
        
        if (!downloadUrl) return reply.code(502).send('Link Gen Failed');

        // [关键优化] 触发“下一集”预加载
        tryPrefetchNextEpisode(fileMeta);

        // 使用 307 临时重定向，不缓存重定向本身太久，防止直链过期
        // 但可以告诉客户端这个直链暂时有效
        return reply.redirect(302, downloadUrl); 
    } catch (e) {
        console.error(`Download Error:`, e);
        return reply.code(502).send('Error');
    }
}