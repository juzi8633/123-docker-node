// src/services/service189.js
import crypto from 'node:crypto'; // [新增] 引入 Node 原生 crypto 模块
import { createLogger } from '../logger.js'; // [优化] 引入日志模块

/**
 * 189网盘秒传服务
 */

// [优化] 初始化模块专用日志
const logger = createLogger('Service189');

async function sendEvent(writer, type, data) {
  try {
    // 适配 Fastify writer 和流式响应
    await writer.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  } catch (e) {
    // Suppress errors on closed streams (保持原有逻辑，不打印 SSE 断开的噪音)
    // 如果需要调试，可以使用 logger.debug(e, 'SSE Write Error');
  }
}

// Fetches and decodes response as UTF-8 text, regardless of headers
async function fetchAsUtf8(url, options) {
    const res = await fetch(url, options);
    const buffer = await res.arrayBuffer();
    return new TextDecoder('utf-8').decode(buffer);
}


/**
 * 创建189网盘秒传JSON
 * @param {string} shareUrl - 分享链接
 * @param {string} sharePwd - 分享密码
 * @param {object} writer - Stream writer for sending events
 */
export async function create189RapidTransfer(shareUrl, sharePwd, writer) {
  logger.info({ shareUrl }, "开始解析189分享链接"); // [新增] 入口日志
  await sendEvent(writer, 'phase', { message: '正在解析分享链接...' });
  
  let match = shareUrl.match(/\/t\/([a-zA-Z0-9]+)/) || shareUrl.match(/[?&]code=([a-zA-Z0-9]+)/);
  if (!match) throw new Error("无效的189网盘分享链接");

  const shareCode = match[1];
  let shareId = shareCode;
  
  if (sharePwd) {
    const checkUrl = `https://cloud.189.cn/api/open/share/checkAccessCode.action?shareCode=${shareCode}&accessCode=${sharePwd}`;
    const checkText = await fetchAsUtf8(checkUrl, { headers: { "Accept": "application/json;charset=UTF-8", "Referer": "https://cloud.189.cn/web/main/" } });
    const checkData = JSON.parse(checkText);
    if (checkData.shareId) shareId = checkData.shareId;
  }
  
  const params = { shareCode, accessCode: sharePwd || "" };
  const timestamp = Date.now().toString();
  const appKey = "600100422";
  // [优化] 使用 await 调用异步签名函数
  const signature = await get189Signature({ ...params, Timestamp: timestamp, AppKey: appKey });
  
  const apiUrl = `https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action?${new URLSearchParams(params)}`;
  
  const text = await fetchAsUtf8(apiUrl, {
    headers: { "Accept": "application/json;charset=UTF-8", "Sign-Type": "1", Signature: signature, Timestamp: timestamp, AppKey: appKey, Referer: "https://cloud.189.cn/web/main/" }
  });

  let data;
  try {
    const fixedText = text.replace(/"(id|fileId|parentId|shareId)":"?(\d{15,})"?/g, '"$1":"$2"');
    data = JSON.parse(fixedText);
  } catch (e) {
    throw new Error("解析分享信息失败 (JSON parsing failed)");
  }

  if (data.res_code !== 0) {
    if (data.res_code === 40401 && !sharePwd) throw new Error("该分享需要提取码");
    logger.warn({ code: data.res_code, msg: data.res_message }, "获取分享信息失败");
    throw new Error(`获取分享信息失败: ${data.res_message || "未知错误"}`);
  }

  if (data.shareId) shareId = data.shareId;
  const fileId = data.fileId;
  const shareMode = data.shareMode || "0";
  const isFolder = data.isFolder;
  const title = data.fileName || "";

  if (!shareId || !fileId) throw new Error("获取分享信息失败，无法获取到 shareId 或 fileId");

  await sendEvent(writer, 'phase', { message: '正在扫描文件...' });

  const files = [];
  if (isFolder) {
      await get189ShareFiles(shareId, fileId, fileId, "", shareMode, sharePwd, shareCode, writer, files);
  } else {
      files.push({
          path: data.fileName,
          etag: (data.md5 || "").toLowerCase(),
          size: data.fileSize,
          source_ref: data.fileId // [新增] 保存 fileId
      });
      await sendEvent(writer, 'scan', { count: 1 });
  }

  logger.info({ count: files.length }, "扫描完成");

  const finalJson = {
    scriptVersion: "3.0.3",
    exportVersion: "1.0",
    usesBase62EtagsInExport: false,
    commonPath: title && isFolder ? title + "/" : "",
    files,
    totalFilesCount: files.length,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
  };

  await sendEvent(writer, 'result', { rapidTransferJson: finalJson });
}

/**
 * 递归获取189网盘分享文件列表
 */
async function get189ShareFiles(shareId, shareDirFileId, fileId, path = "", shareMode = "0", accessCode = "", shareCode = "", writer, allFiles) {
  let page = 1;
  while (true) {
    const params = { pageNum: page, pageSize: 100, fileId, shareDirFileId, isFolder: "true", shareId, shareMode, iconOption: "5", orderBy: "lastOpTime", descending: "true", accessCode: accessCode || "" };
    const url = `https://cloud.189.cn/api/open/share/listShareDir.action?${new URLSearchParams(params)}`;
    const headers = { 'Accept': 'application/json;charset=UTF-8', 'Referer': 'https://cloud.189.cn/web/main/' };
    if (shareCode && accessCode) headers['Cookie'] = `share_${shareCode}=${accessCode}`;

    let data;
    try {
        const text = await fetchAsUtf8(url, { headers });
        const fixedText = text.replace(/"(id|fileId|parentId|shareId)":(\d{15,})/g, '"$1":"$2"');
        data = JSON.parse(fixedText);
    } catch(e) { 
        logger.error(e, "Failed to parse 189 file list");
        break; 
    }

    if (data.res_code !== 0) {
        if (data.res_code === "FileNotFound" && path) {
            logger.warn({ path }, "子文件夹访问失败");
        }
        break;
    }

    const fileList = data.fileListAO?.fileList || [];
    for (const file of fileList) {
      allFiles.push({ 
          path: path ? `${path}/${file.name}` : file.name, 
          etag: (file.md5 || "").toLowerCase(), 
          size: file.size,
          source_ref: `${file.id}|${shareId}`
      });
      await sendEvent(writer, 'scan', { count: allFiles.length });
    }

    const folderList = data.fileListAO?.folderList || [];
    for (const folder of folderList) {
      const folderPath = path ? `${path}/${folder.name}` : folder.name;
      await get189ShareFiles(shareId, folder.id, folder.id, folderPath, shareMode, accessCode, shareCode, writer, allFiles);
    }

    if ((fileList.length + folderList.length) < 100) break;
    page++;
  }
}

/**
 * [优化] 修复了在 Node.js 环境下无法使用 Web Crypto API 进行 MD5 计算的问题
 * 改用 Node.js 原生的 crypto 模块
 */
async function get189Signature(params) {
  const sortedParams = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
  return await nativeMD5(sortedParams);
}

// [核心修改] 使用 Node.js 原生 crypto 模块替代 crypto.subtle
async function nativeMD5(message) {
  return crypto.createHash('md5').update(message).digest('hex');
}