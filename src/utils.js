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

export function calculateScore(analysis, sizeBytes, isMovie) {
    let score = 500;
    if (!analysis) return score;
    const { resolution, tagsArray } = analysis;
    const sizeInGB = Number(sizeBytes) / (1024 * 1024 * 1024);
    const minGolden = isMovie ? 5 : 1.5;
    const maxGolden = isMovie ? 30 : 15;
    const isGoldenZone = sizeInGB >= minGolden && sizeInGB <= maxGolden;

    let effResolution = resolution;
    if (!effResolution && sizeInGB >= minGolden) {
        effResolution = '1080p';
        if (sizeInGB > (maxGolden / 2)) effResolution = '2160p';
    }

    if (effResolution === '8K') score += 4000;
    else if (effResolution === '2160p') score += 3000;
    else if (effResolution === '1080p') score += 2000;
    else if (effResolution === '720p') score += 1000;

    if (tagsArray.includes('Remux')) score += 2000;
    else if (tagsArray.includes('BluRay')) score += 1500;
    else if (tagsArray.includes('WEB-DL')) score += 1000;

    if (tagsArray.includes('H265') || tagsArray.includes('AV1')) score += isGoldenZone ? 600 : 200;
    else if (tagsArray.includes('H264')) score += (effResolution === '2160p' ? -500 : 50);

    if (tagsArray.includes('HDR')) score += 400;
    if (tagsArray.includes('DV')) score += tagsArray.includes('HDR') ? 200 : -200;

    if (tagsArray.includes('Atmos') || tagsArray.includes('DTS-X')) score += 400;
    else if (tagsArray.includes('TrueHD') || tagsArray.includes('DTS-HD')) score += 300;
    else if (tagsArray.includes('DDP')) score += 100;

    let sizeWeight = isGoldenZone ? 200 : (sizeInGB < minGolden ? 50 : 20);
    score += Math.min(Math.round(sizeInGB * sizeWeight), 2000);

    return Math.round(score);
}