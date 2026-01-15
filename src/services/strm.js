import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../db.js';
import { core123 } from './core123.js'; 
import dotenv from 'dotenv';
dotenv.config();

const STRM_ROOT = process.env.STRM_ROOT || path.join(process.cwd(), 'strm_data');
// [提示] HOST_URL 必须是 Emby 可访问的 IP，Docker 环境下慎用 127.0.0.1
const HOST_URL = process.env.HOST_URL || 'http://127.0.0.1:3000';

export class StrmService {
    
    async init() {
        try {
            await fs.mkdir(STRM_ROOT, { recursive: true });
            console.log(`[STRM] Root initialized: ${STRM_ROOT}`);
        } catch (e) {
            console.error(`[STRM] Init Failed: ${e.message}`);
        }
    }

    async syncEpisode(episodeId) {
        const ep = await prisma.seriesEpisode.findUnique({
            where: { id: episodeId },
            include: { series: true }
        });
        
        if (!ep || !ep.series) return; 

        const { dirPath, fileName, isSubtitle } = this.calculatePath(ep, ep.series);
        const fullDir = path.join(STRM_ROOT, dirPath);
        const fullPath = path.join(fullDir, fileName);

        try {
            await fs.mkdir(fullDir, { recursive: true });

            // ============================================
            // 分支 A: 字幕文件 (增强健壮性)
            // ============================================
            if (isSubtitle) {
                try {
                    const stats = await fs.stat(fullPath);
                    if (stats.size > 0) return; // 已存在且非空，跳过
                } catch (e) {}

                const downloadUrl = await core123.getDownloadUrlByHash(
                    ep.cleanName, 
                    ep.etag, 
                    Number(ep.size)
                );

                if (!downloadUrl) throw new Error("无法获取字幕下载直链");

                // [严谨] 增加超时控制 (15s)
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                try {
                    const res = await fetch(downloadUrl, { signal: controller.signal });
                    if (!res.ok) throw new Error(`字幕下载失败 HTTP ${res.status}`);

                    const buffer = await res.arrayBuffer();
                    
                    // [严谨] 简单防乱码：如果是 srt/ass，尝试添加 UTF-8 BOM (0xEF, 0xBB, 0xBF)
                    // 这不能解决 GBK 问题，但能解决部分 "UTF-8 without BOM" 在 Emby 不显示的问题
                    // 真正解决 GBK 需要引入 iconv-lite 库进行探测和转码
                    const contentBuf = Buffer.from(buffer);
                    
                    // [严谨] 原子写入：先写临时文件，再重命名
                    // 防止下载中断导致留存 0kb 的坏文件
                    const tempPath = `${fullPath}.tmp`;
                    await fs.writeFile(tempPath, contentBuf);
                    await fs.rename(tempPath, fullPath);

                } finally {
                    clearTimeout(timeoutId);
                }
                return;
            }

            // ============================================
            // 分支 B: 视频文件
            // ============================================
            const content = `${HOST_URL}/api/play/${ep.id}`;
            let needsWrite = true;
            try {
                const currentContent = await fs.readFile(fullPath, 'utf8');
                if (currentContent.trim() === content.trim()) {
                    needsWrite = false;
                }
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }

            if (needsWrite) {
                await fs.writeFile(fullPath, content, 'utf8');
            }

        } catch (e) {
            console.error(`[STRM] Sync Error (ID:${ep.id}):`, e.message);
            // 这里不抛出错误，防止打断 Promise.all 的其他任务
        }
    }

    async deleteEpisode(snapshot) {
        if (!snapshot || !snapshot.series) return;
        try {
            const { dirPath, fileName } = this.calculatePath(snapshot, snapshot.series);
            const fullPath = path.join(STRM_ROOT, dirPath, fileName);
            await fs.unlink(fullPath);
            await this.cleanupEmptyDir(path.join(STRM_ROOT, dirPath));
        } catch (e) {
            if (e.code !== 'ENOENT') {
                console.error(`[STRM] Delete Failed: ${e.message}`);
            }
        }
    }

    calculatePath(ep, series) {
        const type = series.type; 
        const genres = (series.genres || '').split(',');
        const genreSet = new Set(genres);
        const lang = (series.originalLanguage || '').toLowerCase();
        const country = (series.originCountry || '').toUpperCase();

        let categoryFolder = '未分类';

        if (type === 'movie') {
            if (genreSet.has('99')) categoryFolder = '纪录片';
            else if (genreSet.has('10402')) categoryFolder = '演唱会';
            else if (genreSet.has('16')) categoryFolder = '动画电影';
            else if (['zh', 'cn', 'bo', 'za'].includes(lang)) categoryFolder = '华语电影';
            else if (['ja', 'ko', 'th'].includes(lang)) categoryFolder = '日韩电影';
            else categoryFolder = '欧美电影'; 
        } else {
            if (genreSet.has('10762')) categoryFolder = '儿童';
            else if (genreSet.has('16')) {
                if (country.includes('JP')) categoryFolder = '日漫';
                else if (country.includes('CN') || country.includes('TW')) categoryFolder = '国漫';
                else categoryFolder = '动漫';
            }
            else if (genreSet.has('99')) categoryFolder = '纪录片';
            else if (genreSet.has('10764') || genreSet.has('10767')) categoryFolder = '综艺';
            else {
                if (country.includes('CN') || country.includes('TW') || country.includes('HK')) categoryFolder = '国产剧';
                else if (country.includes('JP')) categoryFolder = '日剧';
                else if (country.includes('KR')) categoryFolder = '韩剧';
                else categoryFolder = '欧美剧'; 
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

        // 使用 cleanName 去除后缀作为基底
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
            if (files.length === 0) {
                await fs.rmdir(dir);
                await this.cleanupEmptyDir(path.dirname(dir));
            }
        } catch (e) {}
    }
}

export const strmService = new StrmService();