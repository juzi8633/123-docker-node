// src/services/core123.js
import redis from '../redis.js';
import { prisma } from '../db.js'; 
import dotenv from 'dotenv';
import { setGlobalDispatcher, Agent } from 'undici'; 
import { LRUCache } from 'lru-cache'; 
// [修改] 引入项目统一日志模块
import { createLogger } from '../logger.js';

dotenv.config();

// [修改] 初始化 Core123 专用 Logger
const logger = createLogger('Core123');

// =========================================================================
// [配置] 网络层面：配置全局 HTTP 连接池
// =========================================================================
const agent = new Agent({
    keepAliveTimeout: 15000, 
    connections: 10,         
    pipelining: 1,           
    connect: { timeout: 10000 }
});
setGlobalDispatcher(agent);

function getDatestamp(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
}

const memoryCache = new LRUCache({ max: 1000, ttl: 1000 * 60 * 60 });
// 用于防止“惊群效应”的请求合并 Map
const inflightRequests = new Map();

export class Core123Service {
  constructor() {
    this.domain = "https://open-api.123pan.com";
    this.platform = "open_platform";
    this.vipAccount = null;
    this.workers = [];
    this.workerIndex = 0;
    this.rootFolderId = 0;
    this.VIP_CACHE_NAME = "123_Node_Cache"; 
    this.WORKER_CACHE_NAME = "123_Worker_Probe";
    this.KEY_TOKEN_PREFIX = "123:token:";
    this.KEY_DLINK_PREFIX = "123:dlink:";
    this.KEY_DIR_PREFIX = "123:dir:"; 
  }

  async reloadConfig() {
    try {
        logger.info('正在从数据库热重载配置...'); 
        const configs = await prisma.systemConfig.findMany({
            where: { key: { in: ['vip_id', 'vip_secret', 'worker_accounts', 'root_folder_id'] } }
        });
        const configMap = configs.reduce((acc, cur) => ({ ...acc, [cur.key]: cur.value }), {});

        if (configMap.vip_id && configMap.vip_secret) {
            this.vipAccount = { id: configMap.vip_id, secret: configMap.vip_secret, role: 'vip' };
            logger.info({ vipId: configMap.vip_id }, `VIP 账号加载成功`); 
        } else {
            logger.warn(`[配置警告] 数据库中未配置 VIP 账号`);
            this.vipAccount = null;
        }

        this.workers = [];
        if (configMap.worker_accounts) {
            const list = configMap.worker_accounts.split(',');
            for (const item of list) {
                const parts = item.split(':');
                if (parts.length >= 2) {
                    const id = parts[0].trim();
                    const secret = parts[1].trim();
                    if (id && secret) this.workers.push({ id, secret, role: 'worker' });
                }
            }
        }
        logger.info({ count: this.workers.length }, `工兵账号加载完成`); 

        if (this.workers.length === 0 && this.vipAccount) {
            this.workers.push(this.vipAccount);
            logger.info(`未检测到工兵账号，自动使用 VIP 账号作为探测降级`); 
        }
        this.rootFolderId = parseInt(configMap.root_folder_id || "0");
        if (isNaN(this.rootFolderId)) this.rootFolderId = 0;
        this.workerIndex = 0;
    } catch (e) {
        logger.error({ err: e }, `配置重载失败`);
    }
  }

  async fetchJson(url, options) {
    const optimizedHeaders = {
        ...options.headers,
        "Connection": "keep-alive",
        "User-Agent": "Mozilla/5.0 (Node.js; Docker) 123-Node-Server/2.1"
    };
    try {
        // logger.debug({ method: options.method, url }, `发起 API 请求`);
        const res = await fetch(url, { ...options, headers: optimizedHeaders });
        if (!res.ok) {
            const text = await res.text();
            logger.error({ status: res.status, url, response: text.slice(0, 200) }, `API HTTP 请求失败`);
            throw new Error(`API Error ${res.status}: ${text.slice(0, 100)}`);
        }
        const data = await res.json();
        
        // 业务逻辑错误记录
        if (data.code !== 0) {
            // 某些特定的业务 code (如 4025 目录已存在) 可能是预期的，记录为 info 或 warn
            logger.warn({ code: data.code, msg: data.message, url }, `123 API 返回非零状态码`);
        }
        return data;
    } catch (err) {
        logger.error({ err: err.message }, `网络层请求异常`);
        throw err;
    }
  }

  async getTokenForAccount(account) {
    if (!account || !account.id || !account.secret) throw new Error("无效的账号凭证");
    const cacheKey = `${this.KEY_TOKEN_PREFIX}${account.id}`;
    
    // 1. 查内存
    if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);
    
    // 2. 查 Redis
    const cached = await redis.get(cacheKey);
    if (cached) { 
        memoryCache.set(cacheKey, cached); 
        return cached; 
    }

    // 3. 重新获取
    const url = `${this.domain}/api/v1/access_token`;
    const data = await this.fetchJson(url, {
        method: "POST",
        headers: { "Platform": this.platform, "Content-Type": "application/json" },
        body: JSON.stringify({ clientID: account.id, clientSecret: account.secret })
    });

    if (data.code !== 0) {
        logger.error({ accountId: account.id, data }, `[鉴权失败] Token 获取被拒绝`); 
        throw new Error(`Token获取失败 (${account.id}): ${data.message}`);
    }
    const token = data.data.accessToken;
    // 缓存 2500000 秒 (约 29 天，官方 token 有效期通常很长)
    await redis.set(cacheKey, token, 'EX', 2500000);
    memoryCache.set(cacheKey, token);
    return token;
  }

  async getVipToken() { 
      if (!this.vipAccount) {
          await this.reloadConfig();
          if (!this.vipAccount) throw new Error("未配置 VIP 账号");
      }
      return this.getTokenForAccount(this.vipAccount); 
  }

  async getWorkerToken() {
      if (this.workers.length === 0) {
          await this.reloadConfig();
          if (this.workers.length === 0) throw new Error("没有可用的工兵账号");
      }
      // 轮询策略 (Round Robin)
      const worker = this.workers[this.workerIndex];
      this.workerIndex = (this.workerIndex + 1) % this.workers.length;
      return { token: await this.getTokenForAccount(worker), account: worker };
  }
  
  async getUploadParentID() {
      const token = await this.getVipToken();
      return this.getCacheDirID(this.vipAccount, token);
  }

  async initLinkCacheFolder() {
      if (!this.vipAccount) await this.reloadConfig();
      if (!this.vipAccount) return;
      try {
          const token = await this.getVipToken();
          const dirId = await this.getCacheDirID(this.vipAccount, token);
          logger.info({ dirId }, `初始化缓存目录成功`);
      } catch (e) {
          logger.error({ err: e.message }, `初始化缓存目录异常`);
      }
  }

  async getCacheDirID(account, token) {
      const baseName = account.role === 'vip' ? this.VIP_CACHE_NAME : this.WORKER_CACHE_NAME;
      // 按天生成目录名，例如 123_Node_Cache_2023-10-27
      const folderName = `${baseName}_${getDatestamp(0)}`; 
      const redisKey = `${this.KEY_DIR_PREFIX}${account.id}:${folderName}`;
      
      const cachedId = await redis.get(redisKey);
      if (cachedId) return parseInt(cachedId);

      const parentId = account.role === 'vip' ? this.rootFolderId : 0;
      // logger.debug({ folderName, parentId }, `请求创建/获取目录`);

      const createRes = await this.fetchJson(`${this.domain}/upload/v1/file/mkdir`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
          body: JSON.stringify({ name: folderName, parentID: parentId })
      });

      let dirID = 0;
      if (createRes.code === 0) {
          dirID = createRes.data.dirID;
          logger.info({ dirID, folderName }, `成功创建新缓存目录`); 
      } 
      // 处理目录已存在的情况 (Code 4025 或 1 或 消息包含 exist/同名)
      else if (createRes.code === 4025 || createRes.code === 1 || createRes.message.includes("exist") || createRes.message.includes("同名")) {
          // logger.debug(`目录已存在，正在通过列表反查 ID...`);
          const listRes = await this.fetchJson(`${this.domain}/api/v1/file/list?parentFileId=${parentId}&page=1&limit=100`, {
              method: "GET",
              headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform }
          });
          if (listRes.code === 0 && listRes.data?.fileList) {
              const target = listRes.data.fileList.find(f => f.filename === folderName && f.type === 1);
              if (target) {
                  dirID = target.fileID;
                  // logger.debug({ dirID }, `反查获取到存量目录 ID`);
              }
          }
      }

      if (dirID > 0) {
          // 缓存 3 天
          await redis.set(redisKey, String(dirID), 'EX', 259200);
          // 触发一次旧目录清理
          setImmediate(() => this.recycleAllCacheFolders().catch(e => logger.error({ err: e }, '目录回收失败')));
          return dirID;
      }
      return parentId; 
  }

  // 清理昨前天的缓存目录，防止网盘文件堆积
  async recycleAllCacheFolders() {
      if (!this.vipAccount) await this.reloadConfig();
      const accounts = [this.vipAccount, ...this.workers].filter(Boolean);
      // 去重，防止同一个账号既是 VIP 又是 Worker 被处理两次
      const uniqueAccounts = [...new Map(accounts.map(item => [item.id, item])).values()];
      const targetOffsets = [-1, -2]; // 清理昨天(-1)和前天(-2)

      for (const acc of uniqueAccounts) {
          try {
              const token = await this.getTokenForAccount(acc);
              const baseName = acc.role === 'vip' ? this.VIP_CACHE_NAME : this.WORKER_CACHE_NAME;
              for (const offset of targetOffsets) {
                  const targetFolderName = `${baseName}_${getDatestamp(offset)}`;
                  const redisKey = `${this.KEY_DIR_PREFIX}${acc.id}:${targetFolderName}`;
                  
                  const dirId = await redis.get(redisKey);
                  if (dirId) {
                      const res = await this.fetchJson(`${this.domain}/api/v1/file/trash`, {
                          method: "POST",
                          headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
                          body: JSON.stringify({ fileIds: [parseInt(dirId)] })
                      });
                      if (res.code === 0 || res.code === 404) {
                          logger.info({ folder: targetFolderName }, `[清理] 旧缓存目录已移入回收站`);
                          await redis.del(redisKey);
                      }
                  }
              }
          } catch (e) {
            logger.warn({ err: e.message }, `目录回收过程异常`);
          }
      }
  }

  async getFileDetail(fileID, token) {
      try {
          const res = await this.fetchJson(`${this.domain}/api/v1/file/detail?fileID=${fileID}`, {
              method: "GET",
              headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" }
          });
          if (res.code === 0 && res.data) return res.data;
          return null;
      } catch (e) { return null; }
  }

  // [核心] 通过 Hash 获取下载直链
  async getDownloadUrlByHash(filename, etag, size) {
    const redisKey = `${this.KEY_DLINK_PREFIX}${etag}`;
    const cachedUrl = await redis.get(redisKey);
    if (cachedUrl) return cachedUrl;

    // 防止惊群效应：如果同一个 ETag 的请求正在处理中，复用该 Promise
    if (inflightRequests.has(etag)) return inflightRequests.get(etag);

    const task = (async () => {
        try {
            logger.info({ filename, etag }, `[Link] 开始申请新直链`);
            const token = await this.getVipToken();
            const parentID = await this.getCacheDirID(this.vipAccount, token);
            // 123盘文件名过长或含特殊字符会导致 API 报错，这里进行清洗和截断
            const safeName = filename.replace(/[\\/:*?"<>|]/g, "_").substring(0, 90);

            const body = { parentFileID: parentID, filename: safeName, size: Number(size), duplicate: 1 };
            // 兼容 SHA1 (40位) 和 MD5 (32位)
            if (etag.length === 40) body.sha1 = etag; else body.etag = etag;

            // 1. [关键] VIP 秒传探测 (duplicate: 1)
            // 这一步实际上是在云端创建一个文件的“副本”，如果云端有这个 hash，则秒传成功
            const createRes = await this.fetchJson(`${this.domain}/upload/v2/file/create`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            // 如果 reuse 为 false，说明云端没有这个文件，无法生成直链
            if (createRes.code !== 0 || !createRes.data?.reuse) {
                logger.warn({ code: createRes.code, reuse: createRes.data?.reuse, filename }, `[Link] 秒传失败，云端可能无此文件`);
                throw new Error(`VIP秒传失败: ${safeName}`);
            }

            // 2. 获取直链
            // 拿着上一步创建成功的 fileID 去换取下载地址
            const downRes = await this.fetchJson(`${this.domain}/api/v1/file/download_info?fileId=${createRes.data.fileID}`, {
                method: "GET",
                headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform }
            });

            if (downRes.code !== 0) throw new Error(`获取下载地址失败: ${downRes.message}`);
            
            const url = downRes.data.downloadUrl;
            if (url) {
                logger.info({ filename }, `[Link] ✅ 直链获取成功`);
                // 缓存 6 天 (518400秒)
                await redis.set(redisKey, url, 'EX', 518400); 
            }
            return url;
        } finally {
            inflightRequests.delete(etag);
        }
    })();
    
    inflightRequests.set(etag, task);
    return task;
  }

  // [工兵探测] 用于入库前的检查，防止污染 VIP 账号
  async probeFileByHash(filename, hash, size) {
      try {
          const { token, account } = await this.getWorkerToken();
          const parentID = await this.getCacheDirID(account, token);
          const safeName = filename.replace(/[\\/:*?"<>|]/g, "_").substring(0, 255);
          const body = { parentFileID: parentID, filename: safeName, size: Number(size), duplicate: 2 };

          if (hash.length === 40) body.sha1 = hash; else body.etag = hash;

          const res = await this.fetchJson(`${this.domain}/upload/v2/file/create`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
              body: JSON.stringify(body)
          });

          // 123 API 的限流代码通常是 1
          if (res.code === 1) {
              logger.warn(`[Probe] 探测受限 (Rate limited)，等待重试...`);
              await new Promise(r => setTimeout(r, 2000));
              return false;
          }

          if (res.code === 0 && res.data?.reuse === true) {
              const fileID = res.data.fileID;
              
              // [SHA1 洗白逻辑] 
              // 如果输入的是 SHA1 且秒传成功，我们去查询这个文件详情，拿到它真实的 MD5 (etag)
              if (hash.length === 40 && fileID) {
                await new Promise(r => setTimeout(r, 1000)); // 稍等 1 秒让云端同步
                const detail = await this.getFileDetail(fileID, token);
                if (detail && detail.etag && detail.etag.length === 32) {
                    logger.info({ old: hash, new: detail.etag }, `[Probe] SHA1 洗白成功 -> 真实 MD5`);
                    return { reuse: true, correctEtag: detail.etag };
                }
                return false; 
              }
              return true;
          }
          return false;
      } catch (e) {
          logger.warn({ err: e.message }, `[Probe] 探测过程异常`);
          return false;
      }
  }
}
export const core123 = new Core123Service();