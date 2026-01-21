// src/services/strm.js
import fs from 'fs/promises';
import path from 'path';
import crypto from 'node:crypto'; // [新增] 引入 crypto 模块
import { prisma } from '../db.js';
import { core123 } from './core123.js'; 
import dotenv from 'dotenv';
import { createLogger } from '../logger.js'; // [优化] 引入高性能日志

dotenv.config();

// [优化] 初始化模块专用日志
const logger = createLogger('StrmService');

const STRM_ROOT = process.env.STRM_ROOT || path.join(process.cwd(), 'strm');

// === Emby 通知与防抖逻辑变量 ===
let embyDebounceTimer = null;
const EMBY_DEBOUNCE_MS = 15000; // 15秒防抖

// === 触发 Emby 扫描的函数 ===
async function scheduleEmbyScan() {
    if (embyDebounceTimer) {
        clearTimeout(embyDebounceTimer);
    } else {
        logger.info('[Emby] 🕒 计划在 15秒 后刷新 Emby 媒体库...');
    }

    embyDebounceTimer = setTimeout(async () => {
        try {
            logger.info('[Emby] ⚡ 触发 Emby 库扫描...');
            const configRecord = await prisma.systemConfig.findUnique({ where: { key: 'emby_config' } });
            if (!configRecord || !configRecord.value) {
                logger.warn('[Emby] ⚠️ 未配置 Emby 连接信息，跳过刷新');
                return;
            }

            let config;
            try { config = JSON.parse(configRecord.value); } catch (e) { return; }
            if (!config.enabled || !config.host || !config.api_key) return;

            const url = `${config.host}/Library/Refresh?api_key=${config.api_key}`;
            logger.debug(`[Emby] 发送请求: ${url}`);
            
            // 这里虽然没有用 undici agent，但请求频率极低，保持默认 fetch 即可
            const res = await fetch(url, { method: 'POST' });
            
            if (res.ok) logger.info(`[Emby] ✅ 刷新命令发送成功 (HTTP ${res.status})`);
            else logger.error(`[Emby] ❌ 刷新失败: HTTP ${res.status} ${res.statusText}`);
        } catch (e) {
            logger.error(e, `[Emby] ❌ 扫描过程异常`);
        } finally {
            embyDebounceTimer = null;
        }
    }, EMBY_DEBOUNCE_MS);
}

// [新增] 辅助函数：计算内容哈希
function calculateHash(content) {
    return crypto.createHash('md5').update(content).digest('hex');
}

class StrmService {
    constructor() {
        // [修改] 默认值设为环境变量，后续通过 reloadConfig 覆盖
        this.hostUrl = process.env.HOST_URL || 'http://127.0.0.1:3000';
    }

    async init() {
        try {
            await fs.mkdir(STRM_ROOT, { recursive: true });
            // [新增] 初始化时加载数据库中的 Host 配置
            await this.reloadConfig();
            logger.info(`[Init] STRM 根目录就绪: ${STRM_ROOT}`);
        } catch (e) {
            logger.error(e, '[Init] Failed to create STRM root');
            throw e;
        }
    }

    // [新增] 热重载配置方法
    async reloadConfig() {
        try {
            const config = await prisma.systemConfig.findUnique({ where: { key: 'host_url' } });
            if (config && config.value) {
                // 去除末尾斜杠
                this.hostUrl = config.value.replace(/\/$/, '');
                logger.info(`[Config] StrmService HostURL 更新为: ${this.hostUrl}`);
            }
        } catch (e) {
            logger.warn('[Config] 无法从数据库加载 host_url，保持当前值');
        }
    }

    // [拆分逻辑] 1. 视频同步专用 (无网络请求，极速)
    // [优化] 引入 Hash 校验，实现零 I/O 同步
    async syncVideo(ep, options = { overwrite: false }) {
        try {
            const { fullDir, fullPath, playUrl } = this.prepareSyncData(ep);
            if (!playUrl) return; // 防御性编程

            // 1. 计算新内容的指纹 (Hash)
            const newHash = calculateHash(playUrl);

            // 2. [SSD 优化核心] 检查数据库中的 Hash 是否一致
            // 如果 Hash 一致，且不强制覆盖，则完全跳过文件系统操作
            // 注意：需要确保 prisma schema 中已添加 strmHash 字段
            if (ep.strmHash === newHash && !options.overwrite) {
                // logger.debug({ id: ep.id }, '[Video] Hash 匹配，跳过 I/O');
                return;
            }

            // 3. 执行文件写入 (仅当内容变更或强制覆盖时)
            await fs.mkdir(fullDir, { recursive: true });
            await fs.writeFile(fullPath, playUrl, 'utf8');

            // 4. 更新数据库指纹
            // 这样下次同步时就能命中上面的 Hash 检查
            await prisma.seriesEpisode.update({
                where: { id: ep.id },
                data: { strmHash: newHash }
            });

            // 仅在实际写入时记录日志
            logger.info({ file: ep.cleanName, reason: ep.strmHash ? 'hash_mismatch' : 'new_entry' }, `[Video] 🔄 STRM 已更新/生成`);

        } catch (e) {
            logger.error(e, `[Video] ❌ 生成失败 ID:${ep.id}`);
            throw e; // 抛出异常供调用方统计
        }
    }

    // [拆分逻辑] 2. 字幕同步专用 (有网络请求，需外部流控)
    // [修改] 增加 options 支持 overwrite
    async syncSubtitle(ep, options = { overwrite: false }) {
        try {
            const { fullDir, fullPath, isSubtitle } = this.prepareSyncData(ep);
            if (!isSubtitle) return;

            const exists = await fs.access(fullPath).then(() => true).catch(() => false);
            
            // 如果存在且不覆盖，直接返回成功 (跳过下载)
            if (exists && !options.overwrite) {
                return true;
            }

            await fs.mkdir(fullDir, { recursive: true });

            logger.debug({ name: ep.cleanName }, `[Sub] 正在获取字幕直链...`);
            let downloadUrl = "";
            try {
                // 调用 core123 获取下载链接
                downloadUrl = await core123.getDownloadUrlByHash(ep.cleanName, ep.etag, Number(ep.size));
            } catch (err) {
                logger.error(err, `[Sub] ❌ 字幕直链获取失败`);
                return false; 
            }

            if (!downloadUrl) return false;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000); 
            try {
                const res = await fetch(downloadUrl, { signal: controller.signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const buffer = await res.arrayBuffer();
                await fs.writeFile(fullPath, Buffer.from(buffer));
                logger.info({ size: buffer.byteLength }, `[Sub] ✅ 字幕下载成功`);
                return true;
            } catch (fetchErr) {
                logger.error(fetchErr, `[Sub] ❌ 字幕下载失败`);
                throw fetchErr;
            } finally {
                clearTimeout(timeout);
            }
        } catch (e) {
            logger.error(e, `[Sub] ❌ 字幕处理异常 (ID:${ep.id})`);
            return false;
        }
    }

    // [保持兼容] 统一入口 (供 app.js 使用)
    async syncEpisode(episodeId) {
        const ep = await prisma.seriesEpisode.findUnique({
            where: { id: episodeId },
            include: { series: true }
        });

        if (!ep) {
            logger.warn({ episodeId }, `[Sync] ❌ ID 未找到记录`);
            return;
        }

        logger.info({ fileName: ep.cleanName, id: ep.id, type: ep.type }, `[Sync] 处理单文件`);

        try {
            if (ep.type === 'subtitle') {
                await this.syncSubtitle(ep, { overwrite: true });
            } else {
                await this.syncVideo(ep, { overwrite: true });
            }
            await scheduleEmbyScan();
        } catch (e) {
            logger.error(e, `[Sync] ❌ 同步异常 (ID:${episodeId})`);
        }
    }

    // [新增] 辅助函数：统一准备路径和内容数据
    prepareSyncData(ep) {
        const { dirPath, fileName, isSubtitle } = this.calculatePath(ep);
        const fullDir = path.join(STRM_ROOT, dirPath);
        const fullPath = path.join(fullDir, fileName);

        let playUrl = null;
        if (!isSubtitle) {
            const encodedName = encodeURIComponent(ep.cleanName);
            
            // [新增] 安全签名生成
            // 使用环境变量 SECURITY_KEY，如果没有则回退到 CALLBACK_SECRET，再没有则使用默认值
            const secret = process.env.SECURITY_KEY || process.env.CALLBACK_SECRET || 'default_secret_key';
            const signStr = `${ep.etag}|${ep.size}`;
            // HMAC-SHA256 签名
            const sign = crypto.createHmac('sha256', secret).update(signStr).digest('hex');

            // [修改] URL 拼接，追加 &sign 参数
            // [核心修改] 使用 this.hostUrl 动态获取当前配置的域名
            playUrl = `${this.hostUrl}/api/play/stream?hash=${ep.etag}&size=${ep.size}&name=${encodedName}&sign=${sign}`;
        }
        return { fullDir, fullPath, isSubtitle, playUrl };
    }

    async deleteEpisode(ep) {
        if (!ep) return;
        const { dirPath, fileName } = this.calculatePath(ep);
        const fullPath = path.join(STRM_ROOT, dirPath, fileName);
        try {
            await fs.unlink(fullPath);
            logger.info({ fileName }, `[Delete] 🗑️ 文件已删除`);
            
            // 递归清理目录：Season -> Series -> SubCategory -> RootCategory
            let currentDir = path.dirname(fullPath);
            await this.cleanupEmptyDir(currentDir); // 1. Season (or Series for movie)

            currentDir = path.dirname(currentDir);
            await this.cleanupEmptyDir(currentDir); // 2. Series (or Sub for movie)

            currentDir = path.dirname(currentDir);
            await this.cleanupEmptyDir(currentDir); // 3. Sub (or Root for movie)

            currentDir = path.dirname(currentDir);
            await this.cleanupEmptyDir(currentDir); // 4. Root (or STRM_ROOT for movie)
        } catch (e) {
            if (e.code !== 'ENOENT') logger.error(e, `[Delete] ⚠️ 删除失败`);
        }
    }

    // =========================================================================
    // [核心修改] 路径计算：严格修复电影/剧集分类逻辑
    // =========================================================================
    calculatePath(ep) {
        const { series } = ep;
        const type = series.type; // 'movie' or 'tv'
        
        // 默认值
        let rootFolder = "电视剧"; 
        let subFolder = "未分类";

        const isAnimation = series.genres && (series.genres.includes('16') || series.genres.includes('动画'));
        
        // [修复] 逻辑分支：先定 Root，再定 Sub
        if (type === 'movie') {
            rootFolder = '电影';
            
            // [Movie] 动画电影 = 华语电影 = 外语电影
            if (isAnimation) {
                subFolder = '动画电影';
            } else if (series.originalLanguage === 'zh' || series.originalLanguage === 'cn') {
                subFolder = '华语电影';
            } else {
                subFolder = '外语电影';
            }

        } else {
            // [TV] 
            rootFolder = '电视剧';
            
            // 1. 动画优先判断 (国漫/日番)
            if (isAnimation && series.originCountry && series.originCountry.includes('CN')) {
                subFolder = '国漫';
            } else if (isAnimation && series.originCountry && series.originCountry.includes('JP')) {
                subFolder = '日番';
            } 
            // 2. 特殊流派判断 (纪录片/儿童/综艺)
            else if (series.genres && (series.genres.includes('99') || series.genres.includes('纪录片'))) {
                subFolder = '纪录片';
            } else if (series.genres && (series.genres.includes('10762') || series.genres.includes('儿童'))) {
                subFolder = '儿童';
            } else if (series.genres && (series.genres.includes('10764') || series.genres.includes('综艺') || series.genres.includes('真人秀'))) {
                subFolder = '综艺';
            } 
            // 3. 语言/地区判断
            else if (series.originalLanguage === 'zh' || series.originalLanguage === 'cn') {
                subFolder = '国产剧';
            } else if (series.originalLanguage === 'en') {
                subFolder = '欧美剧';
            } else if (series.originalLanguage === 'ja' || series.originalLanguage === 'ko') {
                subFolder = '日韩剧';
            } else {
                subFolder = '未分类';
            }
        }

        const yearStr = series.year || 'Unknown';
        const seriesNameSafe = series.name.replace(/[\\/:*?"<>|]/g, "_").trim();
        const seriesFolder = `${seriesNameSafe} (${yearStr}) {tmdb-${series.tmdbId}}`;

        const isSubtitle = ep.type === 'subtitle';
        let ext = '.strm'; 
        if (isSubtitle) {
            // 保留原始字幕后缀
            const match = ep.cleanName.match(/(\.(srt|ass|ssa|vtt|sub))$/i);
            ext = match ? match[0] : '.srt'; 
        }

        // 去除视频/字幕后缀，作为基础文件名
        const baseName = ep.cleanName.replace(/\.(mp4|mkv|avi|strm|srt|ass|ssa|vtt)$/i, "");
        const fileName = `${baseName}${ext}`;

        let finalDir = "";
        
        // [关键修复] 严格区分目录结构
        if (type === 'movie') {
            // 电影：直接放在系列文件夹下，没有 Season 目录
            // 路径: 电影/外语电影/Avatar (2009) {tmdb-xxx}/Avatar.strm
            finalDir = path.join(rootFolder, subFolder, seriesFolder);
        } else {
            // 剧集：必须放在 Season 目录下
            // 路径: 电视剧/欧美剧/Breaking Bad (2008) {tmdb-xxx}/Season 01/Ep01.strm
            // 处理 season 为 null 或 0 的情况
            const sNum = (ep.season || 0);
            const sStr = String(sNum).padStart(2, '0');
            finalDir = path.join(rootFolder, subFolder, seriesFolder, `Season ${sStr}`);
        }

        return { dirPath: finalDir, fileName, isSubtitle };
    }

    async cleanupEmptyDir(dir) {
        try {
            // 防止删除根目录
            if (path.resolve(dir) === path.resolve(STRM_ROOT)) return;
            
            const files = await fs.readdir(dir);

            // [保持] 定义会被视为"垃圾"的文件后缀
            const IGNORED_EXTS = ['.nfo', '.jpg', '.jpeg', '.png', '.webp', '.tbn', '.xml', '.bif', '.json'];
            
            // 检查是否存在"有效文件"
            const hasValidFiles = files.some(file => {
                const ext = path.extname(file).toLowerCase();
                // 如果没有后缀(通常是子文件夹) 或者 后缀不在忽略列表中，则视为有效内容 -> 保留目录
                return !ext || !IGNORED_EXTS.includes(ext);
            });
            
            if (!hasValidFiles) {
                // 强制递归删除含垃圾文件的目录
                await fs.rm(dir, { recursive: true, force: true });
                logger.debug({ dir }, `[Cleanup] 🗑️ 移除逻辑空目录 (含元数据)`);
            }
        } catch (e) {
            if (e.code !== 'ENOENT') logger.warn({ dir, msg: e.message }, '[Cleanup] ⚠️ 清理失败');
        }
    }
    
    // [新增] 暴露给脚本手动触发扫描
    async triggerScan() {
        await scheduleEmbyScan();
    }
}

export const strmService = new StrmService();