// src/services/serviceQuark.js
import { createLogger } from '../logger.js'; // [优化] 引入日志模块

/**
 * 夸克网盘秒传服务
 */

// [优化] 初始化模块专用日志
const logger = createLogger('ServiceQuark');

async function sendEvent(writer, type, data) {
  try {
    const encoder = new TextEncoder();
    await writer.write(
      encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`)
    );
  } catch (e) {
    logger.error(e, "Failed to write event");
  }
}

/**
 * 创建夸克网盘秒传JSON
 * @param {string} shareUrl - 分享链接
 * @param {string} sharePwd - 分享密码
 * @param {string} cookie - 夸克Cookie
 * @param {object} writer - Stream writer for sending events
 */
export async function createQuarkRapidTransfer(
  shareUrl,
  sharePwd,
  cookie,
  writer
) {
  logger.info({ shareUrl }, "开始解析夸克分享链接");

  const match = shareUrl.match(/\/s\/([a-zA-Z0-9]+)/);
  if (!match) throw new Error("无效的夸克分享链接");

  const shareId = match[1];

  await sendEvent(writer, "phase", { message: "正在获取分享Token..." });

  const tokenRes = await fetchWithRetry(
    "https://pc-api.uc.cn/1/clouddrive/share/sharepage/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ pwd_id: shareId, passcode: sharePwd || "" }),
    }
  );

  const tokenData = await tokenRes.json();
  if (tokenData.code !== 0) {
    logger.warn({ code: tokenData.code, msg: tokenData.message }, "获取夸克token失败");
    throw new Error(`获取夸克token失败: ${tokenData.message || "未知错误"}`);
  }

  const { stoken, title } = tokenData.data;
  logger.info({ title }, "获取分享Token成功");

  await sendEvent(writer, "phase", { message: "正在扫描文件..." });
  const allFileItems = await scanQuarkShareFiles(
    shareId,
    stoken,
    cookie,
    0,
    "",
    writer
  );

  if (allFileItems.length === 0) {
    logger.warn("分享链接中没有文件");
    throw new Error("分享链接中没有文件");
  }

  logger.info({ count: allFileItems.length }, "扫描完成，准备获取 MD5");

  await sendEvent(writer, "phase", {
    message: "扫描完成，正在获取分享文件MD5...",
  });
  const md5Map = await batchGetShareFilesMd5(
    shareId,
    stoken,
    cookie,
    allFileItems,
    writer
  );

  const files = allFileItems.map((item) => ({
    path: item.path,
    etag: (md5Map[item.fid] || "").toLowerCase(),
    size: item.size,
  }));

  const finalJson = {
    scriptVersion: "3.0.3",
    exportVersion: "1.0",
    usesBase62EtagsInExport: false,
    commonPath: title ? title + "/" : "",
    files,
    totalFilesCount: files.length,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
  };

  await sendEvent(writer, "result", { rapidTransferJson: finalJson });
  logger.info("解析结果已发送");
}

/**
 * 递归扫描夸克分享中的所有文件
 */
async function scanQuarkShareFiles(
  shareId,
  stoken,
  cookie,
  parentFileId = 0,
  path = "",
  writer,
  foundFiles = []
) {
  let page = 1;
  // logger.debug({ parentFileId, path }, "正在扫描目录");

  while (true) {
    const url = `https://pc-api.uc.cn/1/clouddrive/share/sharepage/detail?pwd_id=${shareId}&stoken=${encodeURIComponent(
      stoken
    )}&pdir_fid=${parentFileId}&_page=${page}&_size=100&pr=ucpro&fr=pc`;

    const res = await fetchWithRetry(url, {
      headers: { Cookie: cookie, Referer: "https://pan.quark.cn/" },
    });
    const data = await res.json();

    if (data.code !== 0 || !data.data?.list) {
        if (data.code !== 0) logger.warn({ code: data.code, msg: data.message }, "扫描目录接口返回非0");
        break;
    }

    const items = data.data.list;
    for (const item of items) {
      const itemPath = path ? `${path}/${item.file_name}` : item.file_name;
      if (item.dir) {
        await scanQuarkShareFiles(
          shareId,
          stoken,
          cookie,
          item.fid,
          itemPath,
          writer,
          foundFiles
        );
      } else {
        foundFiles.push({
          fid: item.fid,
          token: item.share_fid_token,
          name: item.file_name,
          size: item.size,
          path: itemPath,
        });
        
        // 降低日志频率，仅在特定数量时打印
        if (foundFiles.length % 50 === 0) {
            await sendEvent(writer, "scan", { count: foundFiles.length });
        }
      }
    }
    
    // 补发一次进度，确保前端看到最新数字
    if (items.length > 0 && foundFiles.length % 50 !== 0) {
        await sendEvent(writer, "scan", { count: foundFiles.length });
    }

    if (items.length < 100) break;
    page++;
  }
  return foundFiles;
}

/**
 * 批量获取分享文件的MD5
 */
async function batchGetShareFilesMd5(
  shareId,
  stoken,
  cookie,
  fileItems,
  writer
) {
  const md5Map = {};
  const batchSize = 10;
  let totalProcessed = 0;

  for (let i = 0; i < fileItems.length; i += batchSize) {
    const batch = fileItems.slice(i, i + batchSize);
    const fids = batch.map((item) => item.fid);
    const tokens = batch.map((item) => item.token);

    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const md5Res = await fetchWithRetry(
        `https://pc-api.uc.cn/1/clouddrive/file/download?pr=ucpro&fr=pc`,
        {
          method: "POST",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.14.2 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch",
            "Content-Type": "application/json",
            Cookie: cookie,
            Referer: "https://pan.quark.cn/",
            Origin: "https://pan.quark.cn",
          },
          body: JSON.stringify({
            fids,
            pwd_id: shareId,
            stoken,
            fids_token: tokens,
          }),
        }
      );

      const md5Data = await md5Res.json();
      if (md5Data.code === 0 && md5Data.data) {
        const dataList = Array.isArray(md5Data.data)
          ? md5Data.data
          : [md5Data.data];
        dataList.forEach((item, idx) => {
          const fid = fids[idx];
          if (fid) {
            let md5 = item.md5 || item.hash || "";
            if (md5 && md5.includes("==")) {
              // Base64 MD5
              try {
                const binaryString = atob(md5);
                md5 =
                  binaryString.length === 16
                    ? Array.from(binaryString, (c) =>
                        c.charCodeAt(0).toString(16).padStart(2, "0")
                      ).join("")
                    : "";
              } catch (e) {
                md5 = "";
              }
            }
            md5Map[fid] = md5;
          }
        });
      } else {
          logger.warn({ code: md5Data.code, msg: md5Data.message }, "批量获取MD5接口返回非0");
      }
    } catch (e) {
      logger.error(e, `MD5 batch ${i / batchSize} failed`);
    }

    totalProcessed += batch.length;
    await sendEvent(writer, "progress", {
      processed: totalProcessed,
      total: fileItems.length,
    });
  }
  return md5Map;
}

/**
 * 带重试机制的 fetch
 */
async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status >= 500 || res.status === 429)
        throw new Error(`HTTP status ${res.status}`);
      return res;
    } catch (e) {
      logger.warn({ attempt: i + 1, retries, msg: e.message }, "Request failed, retrying...");
      lastError = e;
      if (i < retries - 1)
        await new Promise((resolve) => setTimeout(resolve, delay * (i + 1)));
    }
  }
  throw lastError;
}