// src/utils.js

export const RE_TMDB_TAG = /\{tmdb=(\d+)\}/i;
export const RE_SEASON_EPISODE = /S(\d+)E(\d+)/i;
export const RE_SUB_EXT = /\.(srt|ass|ssa|sub|vtt)$/i;
export const RE_FILE_EXT = /\.(\w+)$/;
export const RE_SUB_LANG = /[\._-](zh|cn|chs|cht|eng|en|jpn|jp|kor|kr|tc|sc)(?:[\._-][a-z]{2,})?/i;
export const RE_YEAR_IN_NAME = /^(.+?)\s*\((\d{4})\)/;
export const RE_CLEAN_NAME = /[^\u4e00-\u9fa5a-zA-Z0-9\s]/g;
export const RE_SPACE = /\s+/g;
export const RE_HDR = /hdr|hdr10\+/i;
export const RE_DV = /dv|dolby\s*vision/i;

const TAG_REGEXES = [
    { tag: "8K", re: /4320p|8k/i },
    { tag: "2160p", re: /2160p|4k/i },
    { tag: "1080p", re: /1080p/i },
    { tag: "720p", re: /720p/i },
    { tag: "480p", re: /480p/i },
    { tag: "Remux", re: /remux/i },
    { tag: "BluRay", re: /blu-?ray|bdr/i },
    { tag: "WEB-DL", re: /web-?dl/i },
    { tag: "WEBRip", re: /web-?rip/i },
    { tag: "HDTV", re: /hdtv/i },
    { tag: "H265", re: /x265|h\.?265|hevc/i },
    { tag: "H264", re: /x264|h\.?264|avc/i },
    { tag: "AV1", re: /av1/i },
    { tag: "AAC", re: /aac/i },
    { tag: "Atmos", re: /atmos/i },
    { tag: "TrueHD", re: /truehd/i },
    { tag: "DTS-X", re: /dts-?x/i },
    { tag: "DTS-HD", re: /dts-?hd/i },
    { tag: "DTS", re: /dts/i },
    { tag: "DDP", re: /ddp|dd\+|eac3/i },
    { tag: "AC3", re: /ac3/i }
];

export function safeParseYear(input) {
    if (!input) return String(new Date().getFullYear());
    const num = parseInt(input);
    if (isNaN(num)) return String(new Date().getFullYear());
    return String(num);
}

export function detectSubtitleLanguage(filename) {
    const lower = filename.toLowerCase();
    const langMatch = lower.match(RE_SUB_LANG);
    return langMatch ? "." + langMatch[0].replace(/^[\._-]/, '') : "";
}

export function analyzeName(name) {
    const n = name.toLowerCase();
    const tags = [];
    let resolution = "";

    for (const item of TAG_REGEXES) {
        if (n.match(item.re)) {
            // 优先保留最高分辨率标签
            if (!resolution && ["8K","2160p","1080p","720p","480p"].includes(item.tag)) {
                resolution = item.tag;
            }
            tags.push(item.tag);
        }
    }
    const hasHDR = n.match(RE_HDR);
    const hasDV = n.match(RE_DV);
    if (hasHDR) tags.push("HDR");
    if (hasDV) tags.push("DV");

    return { resolution, tagsArray: tags };
}

// === [修改核心] 评分系统 ===
export function calculateScore(analysis, sizeBytes, isMovie) {
    // 1. 先把体积转为 GB
    const sizeInGB = Number(sizeBytes) / (1024 * 1024 * 1024);

    // ============================================
    // 🔥 [新规则] 一票否决区
    // ============================================
    
    // 1. 体积过大 (超过 30GB) -> 0分
    // 这类文件通常是原盘或臃肿版本，不适合在线流媒体
    if (sizeInGB > 30) return 0;

    // 2. 杜比视界 (DV) -> 0分
    // 如果播放器不支持 DV，颜色会发紫/发绿，不如直接不要
    // analysis.tagsArray 包含了 'DV' 标签
    if (analysis && analysis.tagsArray.includes('DV')) return 0;

    // ============================================
    
    let score = 500; // 基础分
    if (!analysis) return score;
    
    const { resolution, tagsArray } = analysis;
    const minGolden = isMovie ? 5 : 1.5;
    const maxGolden = isMovie ? 30 : 15;
    const isGoldenZone = sizeInGB >= minGolden && sizeInGB <= maxGolden;

    // 分辨率加分
    let effResolution = resolution;
    // 如果没有分辨率标签但体积达标，假定为 1080p/4k
    if (!effResolution && sizeInGB >= minGolden) {
        effResolution = '1080p';
        if (sizeInGB > (maxGolden / 2)) effResolution = '2160p';
    }

    if (effResolution === '8K') score += 4000;
    else if (effResolution === '2160p') score += 3000;
    else if (effResolution === '1080p') score += 2000;
    else if (effResolution === '720p') score += 1000;

    // 来源/编码加分
    if (tagsArray.includes('Remux')) score += 2000;
    else if (tagsArray.includes('BluRay')) score += 1500;
    else if (tagsArray.includes('WEB-DL')) score += 1000;

    // 编码偏好: H265/AV1 > H264
    if (tagsArray.includes('H265') || tagsArray.includes('AV1')) score += isGoldenZone ? 600 : 200;
    else if (tagsArray.includes('H264')) score += (effResolution === '2160p' ? -500 : 50);

    // HDR 加分 (DV 已经被上面过滤了，这里只剩纯 HDR)
    if (tagsArray.includes('HDR')) score += 400;

    // 音轨加分
    if (tagsArray.includes('Atmos') || tagsArray.includes('DTS-X')) score += 400;
    else if (tagsArray.includes('TrueHD') || tagsArray.includes('DTS-HD')) score += 300;
    else if (tagsArray.includes('DDP')) score += 100;

    // 黄金体积加分 (Golden Zone)
    let sizeWeight = isGoldenZone ? 200 : (sizeInGB < minGolden ? 50 : 20);
    score += Math.min(Math.round(sizeInGB * sizeWeight), 2000);

    return Math.round(score);
}