// src/services/service123.js
import { createLogger } from '../logger.js'; // [优化] 引入日志模块

/**
 * 123网盘秒传服务 (Debug 版)
 */

// [优化] 初始化模块专用日志
const logger = createLogger('Service123');

async function sendEvent(writer, type, data) {
    try {
        // 这里的 write 应该是 app.js 传入的封装好的 writer.write
        await writer.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    } catch (e) {
        logger.error(e, '[Service123] Failed to write event');
    }
}

const HEADERS = {
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
    'App-Version': '3', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive',
    'LoginUuid': Math.random().toString(36).slice(2),
    'Pragma': 'no-cache', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0',
    'platform': 'web', 'sec-ch-ua': '"Not)A;Brand";v="99", "Microsoft Edge";v="127", "Chromium";v="127"',
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': 'Windows'
};

/**
 * 创建123网盘秒传JSON
 */
export async function create123RapidTransfer(shareUrl, sharePwd = '', writer) {
    logger.info({ shareUrl, sharePwd }, `开始解析任务`);
    await sendEvent(writer, 'phase', { message: '正在解析分享链接...' });

    const match = shareUrl.match(/https:\/\/www\.(123pan\.com|123865\.com|123684\.com|123912\.com|123pan\.cn)\/s\/(?<KEY>[^/?#]+)/i);
    if (!match) {
        logger.warn({ shareUrl }, 'URL 格式校验失败');
        throw new Error("无效的123网盘分享链接");
    }

    const shareKey = match.groups.KEY;
    logger.info({ shareKey }, `提取 ShareKey`);

    // 先获取分享链接的标题
    let shareTitle = "";
    try {
        const infoUrl = `https://www.123pan.com/a/api/share/info?shareKey=${shareKey}`;
        logger.debug(`请求分享详情: ${infoUrl}`);
        
        // [注] 这里的 fetch 会受到 core123.js 全局 Agent 的优化影响 (如果已加载)
        const infoRes = await fetch(infoUrl, { headers: HEADERS });
        logger.debug(`分享详情响应状态: ${infoRes.status}`);
        
        const infoData = await infoRes.json();
        
        if (infoData.code === 0 && infoData.data) {
            shareTitle = infoData.data.ShareTitle || "";
            logger.info(`获取到分享标题: ${shareTitle}`);
        } else {
            logger.warn({ code: infoData.code, msg: infoData.message }, `获取分享标题失败`);
        }
    } catch (e) {
        logger.warn(e, "[Service123] 获取分享标题异常");
    }

    await sendEvent(writer, 'phase', { message: '正在扫描文件...' });
    const files = [];
    
    try {
        await get123ShareFiles(shareKey, sharePwd, 0, "", writer, files);
    } catch (err) {
        logger.error(err, '文件扫描过程中断/出错');
        throw err; // 继续抛出给上层处理
    }

    logger.info({ count: files.length }, `扫描完成`);

    const finalJson = {
        scriptVersion: "3.0.3",
        exportVersion: "1.0",
        usesBase62EtagsInExport: false,
        commonPath: shareTitle ? shareTitle + "/" : "",
        files,
        totalFilesCount: files.length,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
    };

    await sendEvent(writer, 'result', { rapidTransferJson: finalJson });
    logger.info('结果已发送给客户端');
}

/**
 * 递归获取123网盘分享文件列表
 */
async function get123ShareFiles(shareKey, sharePwd = '', parentFileId = 0, path = "", writer, allFiles) {
    let page = 1;
    logger.debug({ parentFileId, path: path || 'root' }, `>> 进入目录扫描`);

    while (true) {
        const url = `https://www.123pan.com/a/api/share/get?limit=100&next=1&orderBy=file_name&orderDirection=asc&shareKey=${shareKey}&SharePwd=${sharePwd}&ParentFileId=${parentFileId}&Page=${page}&event=homeListFile&operateType=1`;
        
        const res = await fetch(url, { headers: HEADERS });
        
        if (!res.ok) {
            logger.error(`HTTP请求失败: ${res.status} ${res.statusText}`);
            throw new Error(`HTTP Error: ${res.status}`);
        }

        const data = await res.json();

        if (data.code !== 0) {
            logger.warn({ code: data.code, msg: data.message }, `API 返回错误`);
            if (page === 1) throw new Error(data.message || "密码错误或分享已失效");
            break;
        }

        const list = data.data?.InfoList || [];
        
        if (list.length === 0) break;

        for (const item of list) {
            const itemPath = path ? `${path}/${item.FileName}` : item.FileName;
            
            if (item.Type === 1) { // 文件夹
                // logger.debug(`发现文件夹: ${item.FileName} (ID: ${item.FileId})`);
                await get123ShareFiles(shareKey, sharePwd, item.FileId, itemPath, writer, allFiles);
            } else { // 文件
                // logger.debug(`发现文件: ${item.FileName}`);
                allFiles.push({ path: itemPath, etag: (item.Etag || "").toLowerCase(), size: item.Size, S3KeyFlag: item.S3KeyFlag });
                
                // 每增加 5 个文件或者总数很少时发送一次进度，减少 SSE 流量
                if (allFiles.length % 5 === 0 || allFiles.length < 10) {
                    await sendEvent(writer, 'scan', { count: allFiles.length });
                }
            }
        }

        if (list.length < 100) {
            break;
        }
        page++;
    }
}