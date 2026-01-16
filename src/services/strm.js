// src/services/strm.js
import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../db.js';
import { core123 } from './core123.js'; 
import dotenv from 'dotenv';
import { createLogger } from '../logger.js'; // [优化] 引入高性能日志

dotenv.config();

// [优化] 初始化模块专用日志
const logger = createLogger('StrmService');

const STRM_ROOT = process.env.STRM_ROOT || path.join(process.cwd(), 'strm');
// [提示] HOST_URL 必须是 Emby 可访问的 IP，Docker 环境下慎用 127.0.0.1
const HOST_URL = process.env.HOST_URL || 'http://127.0.0.1:3000';

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

class StrmService {
    async init() {
        try {
            await fs.mkdir(STRM_ROOT, { recursive: true });
            logger.info(`[Init] STRM 根目录就绪: ${STRM_ROOT}`);
        } catch (e) {
            logger.error(e, '[Init] Failed to create STRM root');
            throw e;
        }
    }

    // 核心：同步单个 Episode (生成 strm/字幕)
    async syncEpisode(episodeId) {
        const ep = await prisma.seriesEpisode.findUnique({
            where: { id: episodeId },
            include: { series: true }
        });

        if (!ep) {
            logger.warn({ episodeId }, `[Sync] ❌ ID 未找到记录`);
            return;
        }

        const { dirPath, fileName, isSubtitle } = this.calculatePath(ep);
        const fullDir = path.join(STRM_ROOT, dirPath);
        const fullPath = path.join(fullDir, fileName);

        logger.info({ fileName, id: ep.id, type: ep.type }, `[Sync] 处理文件`);

        try {
            await fs.mkdir(fullDir, { recursive: true });

            if (isSubtitle) {
                logger.debug(`[Sync] 📥 正在下载字幕内容...`);
                let downloadUrl = "";
                try {
                    // 调用 core123 获取下载链接
                    downloadUrl = await core123.getDownloadUrlByHash(ep.cleanName, ep.etag, Number(ep.size));
                } catch (err) {
                    logger.error(err, `[Sync] ❌ 字幕直链获取失败`);
                    return; 
                }

                if (!downloadUrl) return;

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000); 
                try {
                    const res = await fetch(downloadUrl, { signal: controller.signal });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const buffer = await res.arrayBuffer();
                    await fs.writeFile(fullPath, Buffer.from(buffer));
                    logger.info({ size: buffer.byteLength }, `[Sync] ✅ 字幕写入成功`);
                } catch (fetchErr) {
                    logger.error(fetchErr, `[Sync] ❌ 字幕下载失败`);
                    throw fetchErr;
                } finally {
                    clearTimeout(timeout);
                }
            } else {
                // =========================================================
                // [保持核心] 使用通用播放链接 (Hash + Size + Name)
                // 不再依赖数据库 ID
                // =========================================================
                const encodedName = encodeURIComponent(ep.cleanName);
                const playUrl = `${HOST_URL}/api/play/stream?hash=${ep.etag}&size=${ep.size}&name=${encodedName}`;
                await fs.writeFile(fullPath, playUrl, 'utf8');
                // logger.debug({ fullPath }, `[Sync] ✅ STRM 写入成功`);
            }

            await scheduleEmbyScan();

        } catch (e) {
            logger.error(e, `[Sync] ❌ 同步异常 (ID:${episodeId})`);
        }
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
    // [核心修改] 路径计算：严格按照指定分类方案
    // =========================================================================
    calculatePath(ep) {
        const { series } = ep;
        const type = series.type; // 'movie' or 'tv'
        
        // 默认值
        let rootFolder = "电视剧"; 
        let subFolder = "未分类";

        const isAnimation = series.genres && (series.genres.includes('16') || series.genres.includes('动画'));
        
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
            // [TV] 国漫 = 日番 = 纪录片 = 儿童 = 综艺 = 国产剧 = 欧美剧 = 日韩剧 = 未分类
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
        const seriesNameSafe = series.name.replace(/[\\/:*?"<>|]/g, "_");
        const seriesFolder = `${seriesNameSafe} (${yearStr}) {tmdb-${series.tmdbId}}`;

        const isSubtitle = ep.type === 'subtitle';
        let ext = '.strm'; 
        if (isSubtitle) {
            const match = ep.cleanName.match(/(\.(srt|ass|ssa|vtt|sub))$/i);
            ext = match ? match[0] : '.srt'; 
        }

        const baseName = ep.cleanName.replace(/\.(mp4|mkv|avi|strm|srt|ass|ssa|vtt)$/i, "");
        const fileName = `${baseName}${ext}`;

        let finalDir = "";
        
        if (type === 'movie') {
            finalDir = path.join(rootFolder, subFolder, seriesFolder);
        } else {
            const s = String(ep.season).padStart(2, '0');
            finalDir = path.join(rootFolder, subFolder, seriesFolder, `Season ${s}`);
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
}

export const strmService = new StrmService();