// src/utils/logic.js

// ==========================================
// 基础常量与工具
// ==========================================

export const TMDB_GENRES = {
    28: "动作", 12: "冒险", 16: "动画", 35: "喜剧", 80: "犯罪", 
    99: "纪录", 18: "剧情", 10751: "家庭", 14: "奇幻", 36: "历史", 
    27: "恐怖", 10402: "音乐", 9648: "悬疑", 10749: "爱情", 878: "科幻", 
    10770: "电视电影", 53: "惊悚", 10752: "战争", 37: "西部", 
    10759: "动作冒险", 10762: "儿童", 10763: "新闻", 10764: "真人秀", 
    10765: "科幻奇幻", 10766: "肥皂剧", 10767: "脱口秀", 10768: "战争政治"
};

export const cnNums = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'零':0,'〇':0,'两':2};

// 兼容: {tmdb-123}, [tmdbid=123], (tmdb 123), 【tmdb:123】 等格式
export const TMDB_ID_REGEX = /[\[\(\{【]tmdb(?:id)?[\s\-_=+\/:\.]*(\d+)\s*[\]\)\}】]/i;

export function formatSize(bytes) {
    const num = Number(bytes);
    if (num === 0 || isNaN(num)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(num) / Math.log(k));
    const safeIndex = Math.min(i, sizes.length - 1);
    return parseFloat((num / Math.pow(k, safeIndex)).toFixed(2)) + ' ' + sizes[safeIndex];
}

function cnToInt(str) {
    if (!str) return 0;
    if (/^\d+$/.test(str)) return parseInt(str);
    let val = 0;
    let tmp = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        const n = cnNums[c];
        if (n !== undefined) {
            if (c === '十') {
                val += (tmp === 0 ? 1 : tmp) * 10;
                tmp = 0;
            } else {
                tmp = n;
            }
        }
    }
    return val + tmp;
}

export function parseSeason(text) {
    if (!text) return 0;
    const standardMatch = text.match(/[ \._\-]S(\d+)E\d+/i) || text.match(/^S(\d+)E\d+/i) || text.match(/S(\d+)E\d+/i);
    if (standardMatch) return parseInt(standardMatch[1]);

    const m = text.match(/(?:^|[\.\s_])(?:Season|S)\s*(\d+)(?:[\.\s_]|E|$)/i) || 
              text.match(/第([一二三四五六七八九十0-9]+)季/) ||
              text.match(/(?:第)?([一二三四五六七八九十0-9]+)季(?:全|完结)?/);
    if (m) {
        return /^\d+$/.test(m[1]) ? parseInt(m[1]) : cnToInt(m[1]);
    }
    return 0;
}

export function parseEpisodeDetail(text) {
    if (!text) return { value: null, confidence: 'none', source: 'none' };

    const strongPatterns = [
        { regex: /S\d+[Ee](\d+)/i, source: 'sxe' },
        { regex: /[Ee][Pp]?(\d+)/, source: 'ep' },
        { regex: /第([0-9一二三四五六七八九十两〇零]+)[集话]/, source: 'chinese-episode' },
        { regex: /\[(\d{1,3})\]/, source: 'bracket' },
        { regex: / - (\d{1,3}) (?:\[|t|v|\.)/, source: 'delimited-number' },
        { regex: /(?:^|[^\d])(?:EP?|第)?(\d{1,3})(?:END|FIN|V\d+)?(?:[^\d]|$)/i, source: 'generic-episode' }
    ];

    for (const pattern of strongPatterns) {
        const match = text.match(pattern.regex);
        if (match) {
            const value = /^\d+$/.test(match[1]) ? parseInt(match[1]) : cnToInt(match[1]);
            return { value, confidence: 'strong', source: pattern.source };
        }
    }

    const nameWithoutExt = text.replace(/\.[^/.]+$/, "");
    const looseMatch = nameWithoutExt.match(/^(\d{1,3})(?:[\s\._\-]|$)/);
    if (looseMatch) {
        const num = parseInt(looseMatch[1]);
        const currentYear = new Date().getFullYear();
        if (num > 1888 && num <= currentYear + 2) {
            return { value: null, confidence: 'none', source: 'none' };
        }
        return { value: num, confidence: 'weak', source: 'leading-number' };
    }

    return { value: null, confidence: 'none', source: 'none' };
}

export function parseEpisode(text) {
    return parseEpisodeDetail(text).value;
}

const DATE_REGEX = /(?:20\d{2}[-_\.]\d{1,2}[-_\.]\d{1,2})|(?:20\d{6})/;

const JUNK_TERMS_STRICT = [
    /\b(4k|2160p|1080p|720p|remux|bluray|uhd|hdr|dv|hevc|x26[45]|avc|dts|truehd|atmos|\bma\b|aac|flac|ddp|web-?dl|hdtv|repack|proper|v2|edr)\b/ig,
    /\b(Hi10p|10bit|60fps|vivid|maxplus|hiveweb|momoweb|oldk|老k|PTerWEB|OPS)\b/ig
];

const JUNK_TERMS_LOOSE = [
    /(^|\s)(中英[双两]字|国英[双两]语|国粤[双两]语|中字|字幕|特效)($|\s)/i,
    /(^|\s)(合集|全集|打包|系列|部合集|版本)($|\s)/i,
    /(^|\s)(mp4ba|rarbg|criterion|collection)($|\s)/i,
    /(^|\s)(高码|收藏|\d+帧|邵氏|4K265)($|\s)/i,
    /www\.[a-z0-9]+\.[a-z]+/i,
    /\[.*?\]/g, /【.*?】/g,
    /\(.*?\)/g, /（.*?）/g,
    /(^|\s)Top\d+($|\s)/i,
    /(^|\s)(国语|英语|粤语|双语|HD)($|\s)/i,
    /(^|\s)(高码版?|修正版?|收藏版?)($|\s)/i,
    /(^|\s)(完结|全\d+集|全\d+话|全\d+季|全|简繁|繁中|简中)($|\s)/i,
    /(^|\s)(外挂字幕|内封字幕|内嵌字幕|官译|机翻)($|\s)/i
];

const extractors = {
    year: (str) => {
        const m = str.match(/(?:^|[\.\s_\[\(\（-])(?<year>(?:19|20)\d{2})(?:$|[\.\s_\]\)\）-])/);
        return m?.groups?.year || "";
    },
    
    smartCleanTitle: (fileName) => {
        let raw = fileName
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/：/g, " ")
            .replace(/／/g, " ")
            .replace(/\//g, " ");

        const breakPoints = [
            /(?:19|20)\d{2}/,
            /S\d+E\d+/i, /S\d+/i, /Season\s*\d+/i,
            /第[一二三四五六七八九十0-9]+[季集期话]/,
            /第\d+[-_ ]?\d+[集话]/,
            /先导片|特别篇|特典|SP\d*/i,
            /1080[pP]|720[pP]|2160[pP]|4[kK]|8[kK]/,
            /BluRay|WEB-?DL|WEBRip|HDTV|Remux|ISO|DVD/i,
            /H\.?26[45]|HEVC|AVC|AV1|AAC|DTS|Atmos|TrueHD/i,
        ];

        let cutoffIndex = raw.length;
        for (const regex of breakPoints) {
            const match = raw.match(regex);
            if (match && match.index < cutoffIndex && match.index > 0) {
                cutoffIndex = match.index;
            }
        }

        raw = raw.substring(0, cutoffIndex);
        raw = raw.replace(/[\.\_\-\[\]【】\(\)（）]/g, ' ').trim();
        JUNK_TERMS_STRICT.forEach(regex => { raw = raw.replace(regex, ' '); });
        JUNK_TERMS_LOOSE.forEach(regex => {
            let oldRaw;
            do { oldRaw = raw; raw = raw.replace(regex, ' '); } while (raw !== oldRaw);
        });
        raw = raw
            .replace(/^[\s\._\-]+/, '')
            .replace(/[\s\._\-]+$/, '')
            .replace(/版$/i, '')
            .replace(/\s+/g, ' ')
            .trim();

        return raw;
    }
};

export function extractFileInfo(fullPath) {
    const normalizedPath = fullPath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/').filter(Boolean);
    let fileName = parts[parts.length - 1];
    
    fileName = fileName.replace(/\.(mp4|mkv|avi|mov|wmv|iso|ts|flv|srt|ass|ssa|sub|vtt|rmvb|webm|m2ts)$/i, "");

    let tmdbId = null;
    for (let i = parts.length - 1; i >= Math.max(0, parts.length - 4); i--) {
        const idMatch = parts[i].match(TMDB_ID_REGEX);
        if (idMatch) {
            tmdbId = idMatch[1];
            break;
        }
    }

    let year = extractors.year(fileName);
    if (!year && parts.length >= 2) {
        for (let i = parts.length - 2; i >= Math.max(0, parts.length - 4); i--) {
            const y = extractors.year(parts[i]);
            if (y) { year = y; break; }
        }
    }

    let rawTitle = extractors.smartCleanTitle(fileName);
    let chineseName = "";
    let englishName = "";

    const splitMixedTitle = (title) => {
        const normalized = String(title || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return { chinese: '', english: '' };

        const hasChinese = /[\u4e00-\u9fa5]/.test(normalized);
        const hasEnglish = /[a-zA-Z]/.test(normalized);
        if (!hasChinese || !hasEnglish) {
            return {
                chinese: hasChinese ? normalized : '',
                english: hasEnglish ? normalized : ''
            };
        }

        const parts = normalized.split(/\s{2,}|\s+-\s+|\s+\/\s+/).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
            const chinesePart = parts.find(p => /[\u4e00-\u9fa5]/.test(p) && !/[a-zA-Z]{3,}/.test(p));
            const englishPart = parts.find(p => /[a-zA-Z]/.test(p));
            return {
                chinese: chinesePart || '',
                english: englishPart || ''
            };
        }

        const tailEngMatch = normalized.match(/([a-zA-Z][a-zA-Z0-9\s:：',\-\.!&×]{1,})$/);
        if (tailEngMatch && tailEngMatch.index > 0) {
            const english = tailEngMatch[1].trim();
            const chinese = normalized.substring(0, tailEngMatch.index).trim();
            if (chinese && english && !/^\d+$/.test(english)) {
                return { chinese, english };
            }
        }

        const headEngMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9\s:：',\-\.!&×]{1,})\s+(.+)$/);
        if (headEngMatch) {
            const english = headEngMatch[1].trim();
            const chinese = headEngMatch[2].trim();
            if (chinese && english && /[\u4e00-\u9fa5]/.test(chinese) && !/^\d+$/.test(english)) {
                return { chinese, english };
            }
        }

        return { chinese: normalized, english: '' };
    };

    const mixed = splitMixedTitle(rawTitle);
    chineseName = mixed.chinese || '';
    englishName = mixed.english || '';

    if (!chineseName && !englishName) {
        chineseName = rawTitle;
    }

    chineseName = chineseName.replace(/[\.\s]+$/, '');
    englishName = englishName.replace(/[\.\s]+$/, '');
    
    const normalizeSearchQuery = (text) => String(text || '')
        .replace(/[·・]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    let searchQuery = englishName && englishName.length >= 2 ? englishName : chineseName;
    let fallbackSearchQuery = '';
    let searchQuerySource = englishName && englishName.length >= 2 ? 'file-english' : 'file-chinese';
    const fileDerivedSearchQuery = normalizeSearchQuery(searchQuery);

    const isInvalidTitle = (t) => {
        return !t || 
               t.length < 2 || 
               /^\d+$/.test(t) || 
               /^(?:Season\s*\d+|S\d+E\d+|S\d+|Ep?\d+)$/i.test(t);
    };
    
    if (isInvalidTitle(searchQuery) && parts.length >= 2) {
        const seasonFolderRegex = /^(Season\s*\d+|S\d+|Specials|第[一二三四五六七八九十0-9]+季)$/i;
        for (let i = parts.length - 2; i >= Math.max(0, parts.length - 4); i--) {
            let candidateDir = parts[i];
            if (seasonFolderRegex.test(candidateDir)) continue;
            candidateDir = candidateDir.replace(TMDB_ID_REGEX, '');
            const parentTitle = extractors.smartCleanTitle(candidateDir);
            if (!isInvalidTitle(parentTitle)) {
                const normalizedParentTitle = normalizeSearchQuery(parentTitle);
                if (!isInvalidTitle(fileDerivedSearchQuery) && fileDerivedSearchQuery !== normalizedParentTitle) {
                    fallbackSearchQuery = fileDerivedSearchQuery;
                }
                searchQuery = parentTitle;
                searchQuerySource = 'parent-dir';
                chineseName = parentTitle;
                englishName = "";
                break;
            }
        }
    } else {
        const seasonFolderRegex = /^(Season\s*\d+|S\d+|Specials|第[一二三四五六七八九十0-9]+季)$/i;
        for (let i = parts.length - 2; i >= Math.max(0, parts.length - 4); i--) {
            let candidateDir = parts[i];
            if (seasonFolderRegex.test(candidateDir)) continue;
            candidateDir = candidateDir.replace(TMDB_ID_REGEX, '');
            const parentTitle = extractors.smartCleanTitle(candidateDir);
            if (!isInvalidTitle(parentTitle)) {
                const normalizedParentTitle = normalizeSearchQuery(parentTitle);
                if (normalizedParentTitle && normalizedParentTitle !== fileDerivedSearchQuery) {
                    fallbackSearchQuery = normalizedParentTitle;
                }
                break;
            }
        }
    }

    searchQuery = normalizeSearchQuery(searchQuery);
    fallbackSearchQuery = normalizeSearchQuery(fallbackSearchQuery);

    const episodeInfo = parseEpisodeDetail(fileName);
    const epNum = episodeInfo.value;
    const seasonNum = parseSeason(fileName) || parseSeason(parts[parts.length - 2] || '');
    const isVariety = /第\d+期/.test(fileName) || /先导片|特别篇|特典/.test(fileName);
    const hasSeasonFolder = /Season\s*\d+/i.test(normalizedPath) || /第[一二三四五六七八九十0-9]+季/.test(normalizedPath);
    const hasStrongEpisode = episodeInfo.confidence === 'strong';
    const hasWeakEpisode = episodeInfo.confidence === 'weak';
    const isTV = isVariety || hasStrongEpisode || seasonNum > 0 || hasSeasonFolder || (hasWeakEpisode && (seasonNum > 0 || hasSeasonFolder));

    return {
        originalName: fileName,
        path: fullPath,
        year: year,
        tmdbId: tmdbId,
        chineseName: chineseName,
        englishName: englishName,
        searchQuery: searchQuery,
        fallbackSearchQuery: fallbackSearchQuery,
        searchQuerySource: searchQuerySource,
        isTV: isTV
    };
}

function extractDate(filename) {
    const match = filename.match(DATE_REGEX);
    return match ? match[0] : "";
}

// ==========================================
// 批量分组逻辑
// ==========================================

export function autoGroupFiles(rawFilesData) {
    let files = [];
    let commonPath = "";

    if (Array.isArray(rawFilesData)) {
        files = rawFilesData;
    } else if (rawFilesData && rawFilesData.files) {
        files = rawFilesData.files;
        commonPath = rawFilesData.commonPath || "";
        if (commonPath && !commonPath.endsWith('/')) commonPath += '/';
    }
    
    const ALLOWED_EXTENSIONS = /\.(mp4|mkv|avi|mov|wmv|flv|ts|rmvb|webm|m2ts|iso|srt|ass|ssa|sub|vtt)$/i;
    const BLOCK_REGEX = /加更|花絮|彩蛋|采访|预告|幕后|特辑|宣传片|NG片段/;

    const validFiles = [];
    files.forEach(file => {
        const fullPath = commonPath + file.path;
        if (!ALLOWED_EXTENSIONS.test(fullPath)) return;
        if (BLOCK_REGEX.test(fullPath)) return;
        file._fullPath = fullPath;
        validFiles.push(file);
    });

    const groups = {}; 
    validFiles.forEach(file => {
        const info = extractFileInfo(file._fullPath);
        const safeName = info.searchQuery.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
        const groupKey = info.isTV ? `tv_${safeName}` : `movie_${safeName}_${info.year || 'ny'}`;

        if (!groups[groupKey]) {
            groups[groupKey] = {
                key: groupKey,
                searchQuery: info.searchQuery,
                fallbackSearchQuery: info.fallbackSearchQuery || '',
                searchQuerySource: info.searchQuerySource || 'file-chinese',
                year: info.year,
                tmdbId: info.tmdbId,
                isTV: info.isTV,
                files: []
            };
        } else if (info.tmdbId && !groups[groupKey].tmdbId) {
            groups[groupKey].tmdbId = info.tmdbId;
        }
        groups[groupKey].files.push(file);
    });

    Object.values(groups).forEach(group => {
        if (!group.isTV) {
            group.files.forEach(f => {
                const analysis = analyzeName(f.path.split('/').pop());
                f._previewEpStr = analysis.resolution || 'Movie';
            });
            return;
        }

        group.files.sort((a, b) => {
            const dateA = extractDate(a.path.split('/').pop());
            const dateB = extractDate(b.path.split('/').pop());
            if (dateA && dateB) return dateA.localeCompare(dateB);
            return a.path.localeCompare(b.path);
        });

        group.files.forEach(f => {
            const fileName = f.path.split('/').pop();
            const parent = f.path.split('/').length >= 2 ? f.path.split('/')[f.path.split('/').length - 2] : "";
            
            let season = parseSeason(fileName) || parseSeason(parent) || 0;
            let epStr = "?";
            const episodeInfo = parseEpisodeDetail(fileName);
            const ep = episodeInfo.value;
            const canUseEpisode = episodeInfo.confidence === 'strong' || (episodeInfo.confidence === 'weak' && season > 0);
            if (ep !== null && canUseEpisode) {
                epStr = `S${String(season).padStart(2,'0')}E${String(ep).padStart(2,'0')}`;
            }
            f._previewSeason = season;
            f._previewEpStr = epStr;
        });
    });

    return Object.values(groups).sort((a, b) => b.files.length - a.files.length);
}

export function analyzeName(name) {
    const n = name.toLowerCase();
    const tags = [];
    let resolution = "";

    if (n.match(/4320p|8k/)) { resolution = "8K"; tags.push("8K"); }
    else if (n.match(/2160p|4k/)) { resolution = "2160p"; tags.push("2160p"); }
    else if (n.match(/1080p/)) { resolution = "1080p"; tags.push("1080p"); }
    else if (n.match(/720p/)) { tags.push("720p"); }
    else if (n.match(/576p/)) { tags.push("576p"); }
    else if (n.match(/480p/)) { tags.push("480p"); }

    if (n.match(/remux/)) tags.push("Remux");
    if (n.match(/blu-?ray|bdr/)) tags.push("BluRay");
    if (n.match(/web-?dl|web-?rip/)) tags.push("WEB-DL");
    if (n.match(/hdtv/)) tags.push("HDTV");
    
    if (n.match(/x265|h\.?265|hevc/)) tags.push("H265");
    else if (n.match(/x264|h\.?264|avc/)) tags.push("H264");
    else if (n.match(/av1/)) tags.push("AV1");

    if (n.match(/hdr/)) tags.push("HDR");
    if (n.match(/dv|dolby\s*vision/)) tags.push("DV");
    
    if (n.match(/atmos/)) tags.push("Atmos");
    if (n.match(/truehd/)) tags.push("TrueHD");
    if (n.match(/dts-?hd/)) tags.push("DTS-HD");
    else if (n.match(/dts/)) tags.push("DTS");
    if (n.match(/ddp|dd\+|eac3/)) tags.push("DDP");
    else if (n.match(/ac3/)) tags.push("AC3");
    if (n.match(/aac/)) tags.push("AAC");

    return { resolution, tagsArray: tags };
}

// === [修改核心] 评分系统 ===
export function calculateScore(analysis, sizeBytes, isMovie) {
    const sizeInGB = Number(sizeBytes) / (1024 * 1024 * 1024);

    // ============================================
    // 🔥 [新规则] 一票否决区
    // ============================================
    
    // 1. 体积过大 (超过 30GB) -> 0分
    if (sizeInGB > 30) return 0;

    // 2. 杜比视界 (DV) -> 0分
    if (analysis && analysis.tagsArray.includes('DV')) return 0;

    // ============================================

    let score = 500;
    if (!analysis) return score;
    const { resolution, tagsArray } = analysis;
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

    // HDR 加分 (DV 已被否决，这里只剩纯 HDR)
    if (tagsArray.includes('HDR')) score += 400;

    if (tagsArray.includes('Atmos') || tagsArray.includes('DTS-X')) score += 400;
    else if (tagsArray.includes('TrueHD') || tagsArray.includes('DTS-HD')) score += 300;
    else if (tagsArray.includes('DDP')) score += 100;

    let sizeWeight = isGoldenZone ? 200 : (sizeInGB < minGolden ? 50 : 20);
    score += Math.min(Math.round(sizeInGB * sizeWeight), 2000);

    return Math.round(score);
}

export function rebuildJsonWithTmdb(files, info, mediaType, sourceType) {
  const rawTitle = info.name.replace(/[\\/:*?"<>|]/g, '').trim();
  const year = info.year || '';
  const commonPath = `${rawTitle} (${year}) {tmdbid-${info.id}}/`;
  const isMovie = mediaType === 'movie';
  
  const processedFiles = [];
  
  files.forEach(f => {
      const fileName = f.path.split('/').pop();
      const extMatch = fileName.match(/\.(mp4|mkv|avi|mov|wmv|flv|ts|rmvb|webm|m2ts|iso|srt|ass|ssa|sub|vtt)$/i); 
      if(!extMatch) return;
      const isSubtitle = /\.(srt|ass|ssa|sub|vtt)$/i.test(extMatch[0]);

      let epNamePart = "";
      let seasonFolder = "";
      
      if (!isMovie && f._previewEpStr) {
          epNamePart = f._previewEpStr;
          if (f._previewSeason === 0) {
              seasonFolder = "Specials/";
          } else {
              seasonFolder = `Season ${String(f._previewSeason).padStart(2,'0')}/`;
          }
      } else if (!isMovie) {
          epNamePart = "S01E01"; 
          seasonFolder = "Season 01/";
      }

      const analysis = isSubtitle ? null : analyzeName(fileName);
      const langTag = isSubtitle ? detectSubtitleLanguage(fileName) : "";
      
      // 使用新的评分逻辑
      let finalScore = (!isSubtitle && analysis) ? calculateScore(analysis, f.size, isMovie) : 0;
      
      let videoBaseNameTemplate = ""; 
      if (!isSubtitle) {
          const tags = analysis ? analysis.tagsArray : [];
          const nameParts = [rawTitle, epNamePart, year, ...tags];
          videoBaseNameTemplate = nameParts.filter(Boolean).join('.');
      }

      processedFiles.push({
          epKey: epNamePart, 
          isSubtitle,
          seasonFolder,
          ext: extMatch[0],
          langTag,
          originalName: fileName,
          videoBaseNameTemplate, 
          data: { 
              path: f.path, 
              etag: f.etag, 
              size: f.size, 
              source_ref: f.source_ref || '',
              source_type: sourceType,
              type: isSubtitle ? 'subtitle' : 'video',
              score: finalScore,
              S3KeyFlag: f.S3KeyFlag || ''
          },
          score: finalScore 
      });
  });

  const finalFiles = [];
  const groups = {};
  processedFiles.forEach(item => { if(!groups[item.epKey]) groups[item.epKey]=[]; groups[item.epKey].push(item); });
  
  for(const key in groups) {
      const items = groups[key];
      const videos = items.filter(i => !i.isSubtitle).sort((a,b) => b.score - a.score);
      const subs = items.filter(i => i.isSubtitle);
      
      if(videos.length > 0) {
          const best = videos[0];
          // 如果最佳版本的得分是 0，说明所有版本都被否决了
          
          const finalName = best.videoBaseNameTemplate + best.ext;
          
          finalFiles.push({ ...best.data, path: best.seasonFolder + finalName, clean_name: finalName });
          
          subs.forEach((s, idx) => {
              const subName = best.videoBaseNameTemplate + s.langTag + (idx>0?`.${idx}`:'') + s.ext;
              finalFiles.push({ ...s.data, path: best.seasonFolder + subName, clean_name: subName, type: 'subtitle' });
          });
      }
  }

  return { 
      scriptVersion: "3.5.4", exportVersion: "1.0", usesBase62EtagsInExport: false, 
      commonPath: commonPath, files: finalFiles, 
      totalFilesCount: finalFiles.length, totalSize: finalFiles.reduce((a,c)=>a+c.size,0) 
  };
}

function detectSubtitleLanguage(filename) {
    const lower = filename.toLowerCase();
    const langMatch = lower.match(/[\._-](zh|cn|chs|cht|eng|en|jpn|jp|kor|kr|tc|sc)(?:[\._-][a-z]{2,})?/i);
    return langMatch ? "." + langMatch[0].replace(/^[\._-]/, '') : "";
}
