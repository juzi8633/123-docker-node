// src/services/core123.js
import redis from '../redis.js';
import { prisma } from '../db.js'; 
import dotenv from 'dotenv';
import { setGlobalDispatcher, Agent } from 'undici'; 
import { LRUCache } from 'lru-cache'; 
dotenv.config();

// =========================================================================
// [优化] 2. 网络层面：配置全局 HTTP 连接池
// =========================================================================
const agent = new Agent({
    keepAliveTimeout: 15000, // 保持连接 15秒，复用 TCP
    connections: 10,         // 最大并发连接数
    pipelining: 1,           // HTTP/1.1 流水线
    connect: {
        timeout: 10000       // 连接超时 10秒
    }
});
setGlobalDispatcher(agent); // 应用到全局 fetch
// =========================================================================

// [新增] 简易日志工具
function log(msg, data = null) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    const prefix = `[Core123 ${time}]`;
    if (data) {
        try {
            const str = JSON.stringify(data, null, 2);
            console.log(`${prefix} ${msg}`, str.length > 2000 ? str.substring(0, 2000) + '... (truncated)' : str);
        } catch (e) {
            console.log(`${prefix} ${msg} [Object]`);
        }
    } else {
        console.log(`${prefix} ${msg}`);
    }
}

// [工具] 获取带偏移量的日期 YYYY-MM-DD
function getDatestamp(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
}

// =========================================================================
// [优化] 3. 缓存层面：LRU
// =========================================================================
const memoryCache = new LRUCache({
    max: 1000,             
    ttl: 1000 * 60 * 60,   
});

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

  // === 配置热重载 ===
  async reloadConfig() {
    try {
        log('[Config] Loading configuration from DB...'); 
        
        const configs = await prisma.systemConfig.findMany({
            where: { 
                key: { in: ['vip_id', 'vip_secret', 'worker_accounts', 'root_folder_id'] } 
            }
        });
        
        const configMap = configs.reduce((acc, cur) => ({ ...acc, [cur.key]: cur.value }), {});

        if (configMap.vip_id && configMap.vip_secret) {
            this.vipAccount = {
                id: configMap.vip_id,
                secret: configMap.vip_secret,
                role: 'vip'
            };
            log(`[Config] VIP Account Loaded: ${configMap.vip_id}`); 
        } else {
            console.warn('[Core123] Warning: VIP account not configured in DB');
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
        log(`[Config] Workers Loaded: ${this.workers.length}`); 

        if (this.workers.length === 0 && this.vipAccount) {
            this.workers.push(this.vipAccount);
            log('[Config] No workers found, using VIP as worker fallback'); 
        }
        
        this.rootFolderId = parseInt(configMap.root_folder_id || "0");
        if (isNaN(this.rootFolderId)) this.rootFolderId = 0;
        
        this.workerIndex = 0;
        
    } catch (e) {
        console.error(`[Core123] Failed to reload config: ${e.message}`);
    }
  }

  async fetchJson(url, options) {
    const optimizedHeaders = {
        ...options.headers,
        "Connection": "keep-alive",
        "User-Agent": "Mozilla/5.0 (Node.js; Docker) 123-Node-Server/2.1"
    };
    try {
        const res = await fetch(url, { ...options, headers: optimizedHeaders });
        if (!res.ok) {
            const text = await res.text();
            // log(`[API Error] HTTP ${res.status} for ${url}`, text); 
            throw new Error(`API Error ${res.status}: ${text.slice(0, 100)}`);
        }
        return await res.json();
    } catch (err) {
        console.error(`[123API] Request Failed: ${err.message}`);
        throw err;
    }
  }

  // === 鉴权逻辑 ===
  async getTokenForAccount(account) {
    if (!account || !account.id || !account.secret) {
        throw new Error("Invalid account credentials");
    }

    const cacheKey = `${this.KEY_TOKEN_PREFIX}${account.id}`;
    if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);
    
    const cached = await redis.get(cacheKey);
    if (cached) {
        memoryCache.set(cacheKey, cached);
        return cached;
    }

    const url = `${this.domain}/api/v1/access_token`;
    const data = await this.fetchJson(url, {
        method: "POST",
        headers: { "Platform": this.platform, "Content-Type": "application/json" },
        body: JSON.stringify({ clientID: account.id, clientSecret: account.secret })
    });

    if (data.code !== 0) {
        log(`[Auth] Failed:`, data); 
        throw new Error(`Token Error (${account.id}): ${data.message}`);
    }
    const token = data.data.accessToken;
    await redis.set(cacheKey, token, 'EX', 2500000);
    memoryCache.set(cacheKey, token);
    return token;
  }

  async getVipToken() { 
      if (!this.vipAccount) {
          await this.reloadConfig();
          if (!this.vipAccount) throw new Error("VIP account not configured");
      }
      return this.getTokenForAccount(this.vipAccount); 
  }

  async getWorkerToken() {
      if (this.workers.length === 0) {
          await this.reloadConfig();
          if (this.workers.length === 0) throw new Error("No worker accounts available");
      }
      const worker = this.workers[this.workerIndex];
      this.workerIndex = (this.workerIndex + 1) % this.workers.length;
      return { token: await this.getTokenForAccount(worker), account: worker };
  }
  
  async getUploadParentID() {
      const token = await this.getVipToken();
      return this.getCacheDirID(this.vipAccount, token);
  }

  // === 初始化 ===
  async initLinkCacheFolder() {
      if (!this.vipAccount) await this.reloadConfig();
      if (!this.vipAccount) return;

      try {
          const token = await this.getVipToken();
          const dirId = await this.getCacheDirID(this.vipAccount, token);
          console.log(`[Core123] Cache folder ready. ID: ${dirId}`);
      } catch (e) {
          console.error(`[Core123] Init cache folder failed: ${e.message}`);
      }
  }

  // === [修复] 自动创建+清理 缓存目录 ===
  async getCacheDirID(account, token) {
      const baseName = account.role === 'vip' ? this.VIP_CACHE_NAME : this.WORKER_CACHE_NAME;
      const folderName = `${baseName}_${getDatestamp(0)}`; 
      const redisKey = `${this.KEY_DIR_PREFIX}${account.id}:${folderName}`;
      
      const cachedId = await redis.get(redisKey);
      if (cachedId) return parseInt(cachedId);

      const parentId = account.role === 'vip' ? this.rootFolderId : 0;

      // 尝试创建
      const createRes = await this.fetchJson(`${this.domain}/upload/v1/file/mkdir`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
          body: JSON.stringify({ name: folderName, parentID: parentId })
      });

      let dirID = 0;
      if (createRes.code === 0) {
          dirID = createRes.data.dirID;
          log(`[Dir] Created new folder ID: ${dirID}`); 
      } else if (createRes.code === 4025 || createRes.code === 1 || createRes.message.includes("exist") || createRes.message.includes("同名")) {
          // 已存在，查询 ID
          const listRes = await this.fetchJson(`${this.domain}/api/v1/file/list?parentFileId=${parentId}&page=1&limit=100`, {
              method: "GET",
              headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform }
          });
          if (listRes.code === 0 && listRes.data?.fileList) {
              const target = listRes.data.fileList.find(f => f.filename === folderName && f.type === 1);
              if (target) {
                  dirID = target.fileID;
              }
          }
      }

      if (dirID > 0) {
          // 缓存 3 天
          await redis.set(redisKey, String(dirID), 'EX', 259200);
          
          // [关键] 成功获取/创建今日目录后，触发旧目录清理
          setImmediate(() => this.recycleAllCacheFolders().catch(e => console.error(e)));
          
          return dirID;
      }
      return parentId; // 降级
  }

  // === [修复] 清理逻辑 ===
  async recycleAllCacheFolders() {
      // 刷新配置确保账号最新
      if (!this.vipAccount) await this.reloadConfig();
      
      const accounts = [this.vipAccount, ...this.workers].filter(Boolean);
      const uniqueAccounts = [...new Map(accounts.map(item => [item.id, item])).values()];
      const targetOffsets = [-1, -2]; // 清理昨天和前天

      for (const acc of uniqueAccounts) {
          try {
              const token = await this.getTokenForAccount(acc);
              const baseName = acc.role === 'vip' ? this.VIP_CACHE_NAME : this.WORKER_CACHE_NAME;

              for (const offset of targetOffsets) {
                  const targetDate = getDatestamp(offset);
                  const targetFolderName = `${baseName}_${targetDate}`;
                  const redisKey = `${this.KEY_DIR_PREFIX}${acc.id}:${targetFolderName}`;
                  
                  // 查 Redis 里的旧 ID
                  const dirId = await redis.get(redisKey);
                  
                  if (dirId) {
                      const res = await this.fetchJson(`${this.domain}/api/v1/file/trash`, {
                          method: "POST",
                          headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
                          body: JSON.stringify({ fileIds: [parseInt(dirId)] })
                      });

                      if (res.code === 0 || res.code === 404) {
                          log(`[Cleanup] Recycled: ${targetFolderName}`);
                          await redis.del(redisKey);
                      }
                  }
              }
          } catch (e) {
              // 忽略清理错误
          }
      }
  }

  // === [新增] 获取文件详情 (用于SHA1洗白) ===
  async getFileDetail(fileID, token) {
      try {
          const url = `${this.domain}/api/v1/file/detail?fileID=${fileID}`;
          const res = await this.fetchJson(url, {
              method: "GET",
              headers: { 
                  "Authorization": `Bearer ${token}`, 
                  "Platform": this.platform,
                  "Content-Type": "application/json"
              }
          });
          if (res.code === 0 && res.data) return res.data;
          return null;
      } catch (e) { return null; }
  }

  // === [修复] VIP 获取直链 (兼容 SHA1) ===
  async getDownloadUrlByHash(filename, etag, size) {
    // 检查缓存
    const redisKey = `${this.KEY_DLINK_PREFIX}${etag}`;
    const cachedUrl = await redis.get(redisKey);
    if (cachedUrl) return cachedUrl;

    if (inflightRequests.has(etag)) return inflightRequests.get(etag);

    const task = (async () => {
        try {
            const token = await this.getVipToken();
            const parentID = await this.getCacheDirID(this.vipAccount, token);
            const safeName = filename.replace(/[\\/:*?"<>|]/g, "_").substring(0, 90);

            // [关键修复] 区分 MD5 和 SHA1
            const body = { 
                parentFileID: parentID,
                filename: safeName, 
                size: Number(size), 
                duplicate: 1 
            };
            
            if (etag.length === 40) {
                body.sha1 = etag; // SHA1 模式
            } else {
                body.etag = etag; // MD5 模式
            }

            // 1. VIP 秒传探测
            const createRes = await this.fetchJson(`${this.domain}/upload/v2/file/create`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            if (createRes.code !== 0 || !createRes.data?.reuse) {
                throw new Error(`VIP秒传失败: ${safeName} (Code: ${createRes.code})`);
            }

            const fileID = createRes.data.fileID;

            // 2. 获取直链 (通过 fileID)
            const downRes = await this.fetchJson(`${this.domain}/api/v1/file/download_info?fileId=${fileID}`, {
                method: "GET",
                headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform }
            });

            if (downRes.code !== 0) throw new Error(`直链失败: ${downRes.message}`);
            const url = downRes.data.downloadUrl;

            if (url) await redis.set(redisKey, url, 'EX', 518400); // 6天
            return url;
        } finally {
            inflightRequests.delete(etag);
        }
    })();

    inflightRequests.set(etag, task);
    return task;
  }

  // === [优化] 工兵探测 (返回 MD5) ===
  async probeFileByHash(filename, hash, size) {
      try {
          const { token, account } = await this.getWorkerToken();
          const parentID = await this.getCacheDirID(account, token);
          const safeName = filename.replace(/[\\/:*?"<>|]/g, "_").substring(0, 255);

          const body = { 
              parentFileID: parentID, 
              filename: safeName, 
              size: Number(size), 
              duplicate: 2 
          };

          const isSha1 = hash.length === 40;
          if (isSha1) body.sha1 = hash;
          else body.etag = hash;

          // 1. 秒传
          const res = await this.fetchJson(`${this.domain}/upload/v2/file/create`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
              body: JSON.stringify(body)
          });

          // 削峰重试逻辑
          if (res.code === 1) {
              log(`[Probe] Rate limited (Code 1), waiting...`);
              await new Promise(r => setTimeout(r, 2000));
              return false; // 简单返回失败，让队列重试
          }

          if (res.code === 0 && res.data?.reuse === true) {
              const fileID = res.data.fileID;
              
              // [SHA1 洗白] 如果是 SHA1，尝试获取真实的 MD5
              if (isSha1 && fileID) {
                await new Promise(r => setTimeout(r, 1000));
                const detail = await this.getFileDetail(fileID, token);
                if (detail && detail.etag && detail.etag.length === 32) {
                    log(`[Probe] Transformed SHA1->MD5: ${detail.etag}`);
                    return { reuse: true, correctEtag: detail.etag }; // 返回对象
                }
                return false; 
              }

              return true; // MD5 模式直接返回 true
          }

          return false;
      } catch (e) {
          console.warn(`[Probe Failed] ${e.message}`);
          return false;
      }
  }
}

export const core123 = new Core123Service();