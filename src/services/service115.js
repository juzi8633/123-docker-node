// src/services/service115.js
import { createLogger } from '../logger.js';

/**
 * 115网盘分享解析服务 (SHA1 版)
 */
const logger = createLogger('Service115');

async function sendEvent(writer, type, data) {
    try {
        await writer.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    } catch (e) {
        logger.error(e, '[Service115] Failed to write event');
    }
}

// 伪造浏览器头，防止 115 拦截
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://115.com/",
    "Origin": "https://115.com",
    "Cache-Control": "no-cache"
};

/**
 * 创建115网盘秒传JSON
 */
export async function create115RapidTransfer(shareUrl, sharePwd, writer) {
    logger.info({ shareUrl }, `开始解析115分享链接`);
    await sendEvent(writer, 'phase', { message: '正在解析分享链接...' });

    // 1. 提取 Share Code
    // 支持格式: https://115.com/s/sw3... 或 ?share_code=...
    let shareCode = "";
    const match = shareUrl.match(/\/s\/([a-z0-9]+)/);
    if (match) {
        shareCode = match[1];
    } else {
        const u = new URL(shareUrl);
        shareCode = u.searchParams.get('share_code');
    }

    if (!shareCode) throw new Error("无效的115分享链接");

    // 2. 获取根目录信息
    // 初始调用，CID 为 "0" (表示根目录)
    
    await sendEvent(writer, 'phase', { message: '正在获取文件列表...' });
    
    const files = [];
    
    try {
        await get115ShareFiles(shareCode, sharePwd, "0", "", writer, files);
    } catch (err) {
        logger.error(err, '115 扫描出错');
        throw err;
    }

    if (files.length === 0) {
        throw new Error("未找到文件或解析失败");
    }

    logger.info({ count: files.length }, `扫描完成`);

    const finalJson = {
        scriptVersion: "3.0.3",
        exportVersion: "1.0",
        usesBase62EtagsInExport: false,
        commonPath: "", // 115 的 snap 接口通常直接返回内容，路径拼接由前端处理
        files,
        totalFilesCount: files.length,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
    };

    await sendEvent(writer, 'result', { rapidTransferJson: finalJson });
    logger.info('结果已发送');
}

/**
 * 递归获取 115 分享文件列表
 */
async function get115ShareFiles(shareCode, receiveCode, cid, path, writer, allFiles) {
    let offset = 0;
    const limit = 100; // 115 分页限制
    
    while (true) {
        // 构造 API URL
        const params = new URLSearchParams({
            share_code: shareCode,
            receive_code: receiveCode || '',
            offset: String(offset),
            limit: String(limit),
            asc: '0',
            o: 'file_name',
            format: 'json'
        });

        if (cid && cid !== "0") {
            params.append('cid', cid);
        }

        // 使用 115cdn.com 作为 API 端点，与前端脚本一致
        const url = `https://115cdn.com/webapi/share/snap?${params.toString()}`;
        
        // 不需要 Cookie，但必须带 Referer
        const res = await fetch(url, { headers: HEADERS });
        const json = await res.json();

        if (!json.state) {
            logger.warn({ error: json.error }, "115 API 返回错误");
            throw new Error(json.error || "获取115数据失败");
        }

        const list = json.data.list || [];
        
        for (const item of list) {
            const itemName = item.n;
            const itemPath = path ? `${path}/${itemName}` : itemName;

            // 判断是文件还是文件夹
            // 在 115 分享接口中，存在 fid 字段的一定是文件
            if (item.fid) {
                // === 文件 ===
                const sha1 = item.sha; // 115 的 SHA1 字段名为 "sha"
                if (sha1) {
                    allFiles.push({
                        path: itemPath,
                        etag: sha1, // 这里存 SHA1，Core123 会自动识别长度
                        size: Number(item.s)
                    });
                    
                    // 降低频率推送进度
                    if (allFiles.length % 10 === 0 || allFiles.length < 10) {
                        await sendEvent(writer, 'scan', { count: allFiles.length });
                    }
                } else {
                    logger.warn({ name: itemName }, "文件缺失 SHA1，跳过");
                }
            } else if (item.cid) {
                // === 文件夹 ===
                // 如果没有 fid 但有 cid，通常是文件夹，递归进入
                await get115ShareFiles(shareCode, receiveCode, item.cid, itemPath, writer, allFiles);
            }
        }

        // 分页检查
        if (list.length < limit) {
            break; // 数据已取完
        }
        offset += limit;
    }
}