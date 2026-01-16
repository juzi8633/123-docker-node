import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../db.js';
import { core123 } from './core123.js'; 
import dotenv from 'dotenv';
dotenv.config();

// [新增] 简易日志工具
function log(msg, data = null) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    const prefix = `[StrmService ${time}]`;
    if (data) {
        try {
            const str = JSON.stringify(data, null, 2);
            console.log(`${prefix} ${msg}`, str.length > 500 ? str.substring(0, 500) + '... (truncated)' : str);
        } catch (e) {
            console.log(`${prefix} ${msg} [Object]`);
        }
    } else {
        console.log(`${prefix} ${msg}`);
    }
}

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
        log('[Emby] 🕒 计划在 15秒 后刷新 Emby 媒体库...');
    }

    embyDebounceTimer = setTimeout(async () => {
        try {
            log('[Emby] ⚡ 触发 Emby 库扫描...');
            const configRecord = await prisma.systemConfig.findUnique({ where: { key: 'emby_config' } });
            if (!configRecord || !configRecord.value) {
                log('[Emby] ⚠️ 未配置 Emby 连接信息，跳过刷新');
                return;
            }

            let config;
            try { config = JSON.parse(configRecord.value); } catch (e) { return; }
            if (!config.enabled || !config.host || !config.api_key) return;

            const url = `${config.host}/Library/Refresh?api_key=${config.api_key}`;
            log(`[Emby] 发送请求: ${url}`);
            const res = await fetch(url, { method: 'POST' });
            if (res.ok) log(`[Emby] ✅ 刷新命令发送成功 (HTTP ${res.status})`);
            else log(`[Emby] ❌ 刷新失败: HTTP ${res.status} ${res.statusText}`);
        } catch (e) {
            log(`[Emby] ❌ 扫描过程异常: ${e.message}`);
        } finally {
            embyDebounceTimer = null;
        }
    }, EMBY_DEBOUNCE_MS);
}

class StrmService {
    async init() {
        try {
            await fs.mkdir(STRM_ROOT, { recursive: true });
            log(`[Init] STRM 根目录就绪: ${STRM_ROOT}`);
        } catch (e) {
            console.error('[StrmService] Init Failed:', e);
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
            log(`[Sync] ❌ ID ${episodeId} 未找到记录`);
            return;
        }

        const { dirPath, fileName, isSubtitle } = this.calculatePath(ep);
        const fullDir = path.join(STRM_ROOT, dirPath);
        const fullPath = path.join(fullDir, fileName);

        log(`[Sync] 处理文件: ${fileName} (ID:${ep.id}, Type:${ep.type})`);

        try {
            await fs.mkdir(fullDir, { recursive: true });

            if (isSubtitle) {
                log(`[Sync] 📥 正在下载字幕内容...`);
                let downloadUrl = "";
                try {
                    downloadUrl = await core123.getDownloadUrlByHash(ep.cleanName, ep.etag, Number(ep.size));
                } catch (err) {
                    log(`[Sync] ❌ 字幕直链获取失败: ${err.message}`);
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
                    log(`[Sync] ✅ 字幕写入成功: ${fullPath} (${buffer.byteLength} bytes)`);
                } catch (fetchErr) {
                    log(`[Sync] ❌ 字幕下载失败: ${fetchErr.message}`);
                    throw fetchErr;
                } finally {
                    clearTimeout(timeout);
                }
            } else {
                // =========================================================
                // [修改核心] 使用通用播放链接 (Hash + Size + Name)
                // 不再依赖数据库 ID
                // =========================================================
                const encodedName = encodeURIComponent(ep.cleanName);
                const playUrl = `${HOST_URL}/api/play/stream?hash=${ep.etag}&size=${ep.size}&name=${encodedName}`;
                await fs.writeFile(fullPath, playUrl, 'utf8');
            }

            await scheduleEmbyScan();

        } catch (e) {
            console.error(`[StrmService] Sync Error (ID:${episodeId}):`, e);
            log(`[Sync] ❌ 同步异常: ${e.message}`);
        }
    }

    async deleteEpisode(ep) {
        if (!ep) return;
        const { dirPath, fileName } = this.calculatePath(ep);
        const fullPath = path.join(STRM_ROOT, dirPath, fileName);
        try {
            await fs.unlink(fullPath);
            log(`[Delete] 🗑️ 文件已删除: ${fileName}`);
            const dir = path.dirname(fullPath);
            await this.cleanupEmptyDir(dir);
            const parentDir = path.dirname(dir);
            await this.cleanupEmptyDir(parentDir);
            const grandParentDir = path.dirname(parentDir);
            await this.cleanupEmptyDir(grandParentDir);
        } catch (e) {
            if (e.code !== 'ENOENT') log(`[Delete] ⚠️ 删除失败: ${e.message}`);
        }
    }

    calculatePath(ep) {
        const { series } = ep;
        const type = series.type; 
        
        let categoryFolder = "其他";
        if (series.genres && (series.genres.includes('16') || series.genres.includes('动画'))) {
            if (series.originCountry && series.originCountry.includes('JP')) categoryFolder = '日漫';
            else if (series.originCountry && series.originCountry.includes('CN')) categoryFolder = '国漫';
            else categoryFolder = '动漫';
        } else if (series.genres && (series.genres.includes('10764') || series.genres.includes('真人秀'))) {
            categoryFolder = '综艺';
        } else if (type === 'movie') {
            if (series.originalLanguage === 'zh' || series.originalLanguage === 'cn') categoryFolder = '华语电影';
            else categoryFolder = '欧美电影'; 
        } else {
            if (series.originalLanguage === 'zh' || series.originalLanguage === 'cn') categoryFolder = '国产剧';
            else if (series.originalLanguage === 'ja') categoryFolder = '日剧';
            else if (series.originalLanguage === 'ko') categoryFolder = '韩剧';
            else categoryFolder = '欧美剧'; 
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
            finalDir = path.join(categoryFolder, seriesFolder);
        } else {
            const s = String(ep.season).padStart(2, '0');
            finalDir = path.join(categoryFolder, seriesFolder, `Season ${s}`);
        }

        return { dirPath: finalDir, fileName, isSubtitle };
    }

    async cleanupEmptyDir(dir) {
        try {
            if (path.resolve(dir) === path.resolve(STRM_ROOT)) return;
            const files = await fs.readdir(dir);
            if (files.length === 0) await fs.rmdir(dir);
        } catch (e) {}
    }
}

export const strmService = new StrmService();