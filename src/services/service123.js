// src/services/service123.js
/**
 * 123网盘秒传服务 (Debug 版)
 */

// [新增] 简易日志工具，带时间戳
function log(msg, data = null) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    const prefix = `[Service123 ${time}]`;
    if (data) {
        console.log(`${prefix} ${msg}`, JSON.stringify(data, null, 2));
    } else {
        console.log(`${prefix} ${msg}`);
    }
}

async function sendEvent(writer, type, data) {
    try {
        const encoder = new TextEncoder();
        // 这里的 write 应该是 app.js 传入的封装好的 writer.write，直接传对象/字符串均可，
        // 但为了保险起见，保持原有的 encoder 逻辑，或者假设 writer.write 已经处理了格式
        // 这里沿用你原代码的逻辑，但要注意 writer.write 如果是 app.js 里的那个，它期待字符串或 buffer
        await writer.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    } catch (e) {
        console.error('[Service123] Failed to write event:', e);
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
    log(`开始解析任务. URL: ${shareUrl}, Pwd: ${sharePwd}`);
    await sendEvent(writer, 'phase', { message: '正在解析分享链接...' });

    const match = shareUrl.match(/https:\/\/www\.(123pan\.com|123865\.com|123684\.com|123912\.com|123pan\.cn)\/s\/(?<KEY>[^/?#]+)/i);
    if (!match) {
        log('URL 格式校验失败');
        throw new Error("无效的123网盘分享链接");
    }

    const shareKey = match.groups.KEY;
    log(`提取 ShareKey: ${shareKey}`);

    // 先获取分享链接的标题
    let shareTitle = "";
    try {
        const infoUrl = `https://www.123pan.com/a/api/share/info?shareKey=${shareKey}`;
        log(`请求分享详情: ${infoUrl}`);
        
        const infoRes = await fetch(infoUrl, { headers: HEADERS });
        log(`分享详情响应状态: ${infoRes.status}`);
        
        const infoData = await infoRes.json();
        // log('分享详情响应数据:', infoData); // 数据可能很多，需要时取消注释

        if (infoData.code === 0 && infoData.data) {
            shareTitle = infoData.data.ShareTitle || "";
            log(`获取到分享标题: ${shareTitle}`);
        } else {
            log(`获取分享标题失败 (Code: ${infoData.code}): ${infoData.message}`);
        }
    } catch (e) {
        console.warn("[Service123] 获取分享标题异常", e);
    }

    await sendEvent(writer, 'phase', { message: '正在扫描文件...' });
    const files = [];
    
    try {
        await get123ShareFiles(shareKey, sharePwd, 0, "", writer, files);
    } catch (err) {
        log('文件扫描过程中断/出错', err);
        throw err; // 继续抛出给上层处理
    }

    log(`扫描完成. 总文件数: ${files.length}`);

    const finalJson = {
        scriptVersion: "3.0.3",
        exportVersion: "1.0",
        usesBase62EtagsInExport: false,
        commonPath: shareTitle ? shareTitle + "/" : "",
        files,
        totalFilesCount: files.length,
        totalSize: files.reduce((sum, f) => sum + f.size, 0),
    };

    // log('生成的最终 JSON (部分):', { ...finalJson, files: `[Array(${files.length})]` });
    await sendEvent(writer, 'result', { rapidTransferJson: finalJson });
    log('结果已发送给客户端');
}

/**
 * 递归获取123网盘分享文件列表
 */
async function get123ShareFiles(shareKey, sharePwd = '', parentFileId = 0, path = "", writer, allFiles) {
    let page = 1;
    log(`>> 进入目录扫描: ID=${parentFileId}, Path=${path || 'root'}`);

    while (true) {
        const url = `https://www.123pan.com/a/api/share/get?limit=100&next=1&orderBy=file_name&orderDirection=asc&shareKey=${shareKey}&SharePwd=${sharePwd}&ParentFileId=${parentFileId}&Page=${page}&event=homeListFile&operateType=1`;
        
        // log(`请求文件列表 (Page ${page})...`);
        const res = await fetch(url, { headers: HEADERS });
        
        if (!res.ok) {
            log(`HTTP请求失败: ${res.status} ${res.statusText}`);
            throw new Error(`HTTP Error: ${res.status}`);
        }

        const data = await res.json();

        if (data.code !== 0) {
            log(`API 返回错误: Code=${data.code}, Msg=${data.message}`);
            if (page === 1) throw new Error(data.message || "密码错误或分享已失效");
            break;
        }

        const list = data.data?.InfoList || [];
        // log(`Page ${page} 获取到 ${list.length} 个项目`);

        if (list.length === 0) break;

        for (const item of list) {
            const itemPath = path ? `${path}/${item.FileName}` : item.FileName;
            
            if (item.Type === 1) { // 文件夹
                // log(`发现文件夹: ${item.FileName} (ID: ${item.FileId})`);
                await get123ShareFiles(shareKey, sharePwd, item.FileId, itemPath, writer, allFiles);
            } else { // 文件
                // log(`发现文件: ${item.FileName}`);
                allFiles.push({ path: itemPath, etag: (item.Etag || "").toLowerCase(), size: item.Size });
                
                // 每增加 5 个文件或者总数很少时发送一次进度，减少 SSE 流量
                if (allFiles.length % 5 === 0 || allFiles.length < 10) {
                    await sendEvent(writer, 'scan', { count: allFiles.length });
                }
            }
        }

        if (list.length < 100) {
            // log(`当前目录 ID=${parentFileId} 扫描完毕 (未满100条)`);
            break;
        }
        page++;
    }
}