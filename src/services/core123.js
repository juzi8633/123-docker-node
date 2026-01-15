import redis from '../redis.js';
import { prisma } from '../db.js'; // [新增] 引入数据库客户端
import dotenv from 'dotenv';
dotenv.config();

const memoryCache = new Map();
const inflightRequests = new Map();

export class Core123Service {
  constructor() {
    this.domain = "https://open-api.123pan.com";
    this.platform = "open_platform";
    
    // [修改] 构造函数不再读取 process.env，改为初始化为空状态
    // 等待 reloadConfig() 被调用
    this.vipAccount = null;
    this.workers = [];
    this.workerIndex = 0;
    this.rootFolderId = 0;
    
    // 固定的缓存目录名称
    this.VIP_CACHE_NAME = "123_Node_Cache"; 
    this.WORKER_CACHE_NAME = "123_Worker_Probe";

    // Redis Keys
    this.KEY_TOKEN_PREFIX = "123:token:";
    this.KEY_DLINK_PREFIX = "123:dlink:";
    // 目录 ID 缓存前缀 (123:dir:client_id)
    this.KEY_DIR_PREFIX = "123:dir:"; 
  }

  // [新增] 从数据库热重载配置
  async reloadConfig() {
    try {
        console.log('[Core123] Loading configuration from DB...');
        
        // 1. 批量读取配置
        const configs = await prisma.systemConfig.findMany({
            where: { 
                key: { in: ['vip_id', 'vip_secret', 'worker_accounts', 'root_folder_id'] } 
            }
        });
        
        const configMap = configs.reduce((acc, cur) => ({ ...acc, [cur.key]: cur.value }), {});

        // 2. 设置 VIP 账号
        if (configMap.vip_id && configMap.vip_secret) {
            this.vipAccount = {
                id: configMap.vip_id,
                secret: configMap.vip_secret,
                role: 'vip'
            };
        } else {
            console.warn('[Core123] Warning: VIP account not configured in DB');
            this.vipAccount = null;
        }

        // 3. 设置工兵账号 (格式: id:secret,id:secret)
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

        // 兜底策略：如果没有工兵，VIP 兼职工兵 (风险较大，仅作Fallback)
        if (this.workers.length === 0 && this.vipAccount) {
            this.workers.push(this.vipAccount);
        }
        
        // 4. 设置根目录 ID
        this.rootFolderId = parseInt(configMap.root_folder_id || "0");
        if (isNaN(this.rootFolderId)) this.rootFolderId = 0;
        
        // 重置轮询索引
        this.workerIndex = 0;
        
        console.log(`[Core123] Config reloaded. VIP: ${!!this.vipAccount}, Workers: ${this.workers.length}, RootDir: ${this.rootFolderId}`);
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

    if (data.code !== 0) throw new Error(`Token Error (${account.id}): ${data.message}`);
    const token = data.data.accessToken;
    await redis.set(cacheKey, token, 'EX', 2500000);
    memoryCache.set(cacheKey, token);
    return token;
  }

  async getVipToken() { 
      // [新增] 运行时检查配置
      if (!this.vipAccount) {
          await this.reloadConfig();
          if (!this.vipAccount) throw new Error("VIP account not configured");
      }
      return this.getTokenForAccount(this.vipAccount); 
  }

  async getWorkerToken() {
      // [新增] 运行时检查配置
      if (this.workers.length === 0) {
          await this.reloadConfig();
          if (this.workers.length === 0) throw new Error("No worker accounts available");
      }
      const worker = this.workers[this.workerIndex];
      this.workerIndex = (this.workerIndex + 1) % this.workers.length;
      return { token: await this.getTokenForAccount(worker), account: worker };
  }
  
  // [新增] 获取上传用的父目录 ID (给离线下载使用)
  async getUploadParentID() {
      const token = await this.getVipToken();
      return this.getCacheDirID(this.vipAccount, token);
  }

  // === 初始化：获取/创建 缓存目录 ===
  async initLinkCacheFolder() {
      // 确保配置已加载
      if (!this.vipAccount) await this.reloadConfig();
      if (!this.vipAccount) {
          console.warn('[Core123] Skip initLinkCacheFolder: No VIP account');
          return;
      }

      try {
          const token = await this.getVipToken();
          const dirId = await this.getCacheDirID(this.vipAccount, token);
          console.log(`[Core123] Cache folder ready. ID: ${dirId}`);
      } catch (e) {
          console.error(`[Core123] Init cache folder failed: ${e.message}`);
      }
  }

  // === 通用：获取/创建 缓存目录 ===
  // 每个账号（VIP或工兵）都有自己的缓存目录 ID，存入 Redis
  async getCacheDirID(account, token) {
      const redisKey = `${this.KEY_DIR_PREFIX}${account.id}`;
      const cachedId = await redis.get(redisKey);
      if (cachedId) return parseInt(cachedId);

      const folderName = account.role === 'vip' ? this.VIP_CACHE_NAME : this.WORKER_CACHE_NAME;
      // 工兵不需要整理到特定 Root 下，直接在它自己的根目录创建即可
      const parentId = account.role === 'vip' ? this.rootFolderId : 0;

      // 1. 尝试创建
      const createRes = await this.fetchJson(`${this.domain}/upload/v1/file/mkdir`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
          body: JSON.stringify({ name: folderName, parentID: parentId })
      });

      let dirID = 0;
      if (createRes.code === 0) {
          dirID = createRes.data.dirID;
      } else if (createRes.code === 4025 || createRes.message.includes("exist")) {
          // 已存在，反查 ID
          const listRes = await this.fetchJson(`${this.domain}/api/v1/file/list?parentFileId=${parentId}&page=1&limit=100`, {
              method: "GET",
              headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform }
          });
          if (listRes.code === 0 && listRes.data?.fileList) {
              const target = listRes.data.fileList.find(f => f.filename === folderName && f.type === 1);
              if (target) dirID = target.fileID;
          }
      }

      if (dirID > 0) {
          // 存入 Redis，有效期设为 25 小时（反正每天都会删，稍微长点没事）
          await redis.set(redisKey, String(dirID), 'EX', 90000);
          return dirID;
      }
      return parentId; // 降级到根目录
  }

  // === [新] 每日清理逻辑 ===
  // 遍历 VIP 和所有工兵，把他们的缓存目录移入回收站
  async recycleAllCacheFolders() {
      console.log('🧹 [Cleanup] Starting daily cache recycling...');
      
      // 每次清理前刷新一次配置，确保清理的是最新账号
      await this.reloadConfig();

      const accounts = [];
      if (this.vipAccount) accounts.push(this.vipAccount);
      accounts.push(...this.workers);
      
      // 去重（防止 VIP 也在 workers 里）
      const uniqueAccounts = [...new Map(accounts.map(item => [item.id, item])).values()];

      for (const acc of uniqueAccounts) {
          try {
              const redisKey = `${this.KEY_DIR_PREFIX}${acc.id}`;
              const dirId = await redis.get(redisKey);
              
              if (dirId) {
                  const token = await this.getTokenForAccount(acc);
                  // 调用移入回收站 API
                  const res = await this.fetchJson(`${this.domain}/api/v1/file/trash`, {
                      method: "POST",
                      headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
                      body: JSON.stringify({ fileIds: [parseInt(dirId)] })
                  });
                  
                  if (res.code === 0) {
                      console.log(`✅ [Cleanup] Recycled folder for ${acc.id}`);
                      // 清除 Redis，下次操作会自动新建
                      await redis.del(redisKey);
                  } else {
                      console.warn(`⚠️ [Cleanup] Failed for ${acc.id}: ${res.message}`);
                  }
              }
          } catch (e) {
              console.error(`❌ [Cleanup] Error for ${acc.id}: ${e.message}`);
          }
      }
  }

  // === VIP 获取直链 (无删除) ===
  async getDownloadUrlByHash(filename, etag, size) {
    const redisKey = `${this.KEY_DLINK_PREFIX}${etag}`;
    const cachedUrl = await redis.get(redisKey);
    if (cachedUrl) return cachedUrl;

    if (inflightRequests.has(etag)) return inflightRequests.get(etag);

    const task = (async () => {
        try {
            const token = await this.getVipToken();
            const parentID = await this.getCacheDirID(this.vipAccount, token);
            const safeName = filename.replace(/[\\/:*?"<>|]/g, "_").substring(0, 90);

            // 1. VIP 秒传 (只管传，不删)
            const createRes = await this.fetchJson(`${this.domain}/upload/v2/file/create`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    parentFileID: parentID,
                    filename: safeName, 
                    etag, 
                    size: Number(size), 
                    duplicate: 1 
                })
            });

            if (createRes.code !== 0 || !createRes.data?.reuse) {
                throw new Error(`VIP秒传失败: ${safeName}`);
            }

            const fileID = createRes.data.fileID;

            // 2. 获取直链
            const downRes = await this.fetchJson(`${this.domain}/api/v1/file/download_info?fileId=${fileID}`, {
                method: "GET",
                headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform }
            });

            if (downRes.code !== 0) throw new Error(`直链失败: ${downRes.message}`);
            const url = downRes.data.downloadUrl;

            // 缓存 6 天 (符合你的需求)
            if (url) await redis.set(redisKey, url, 'EX', 518400); 
            return url;
        } finally {
            inflightRequests.delete(etag);
        }
    })();

    inflightRequests.set(etag, task);
    return task;
  }

  // === 工兵探测 (无删除) ===
  async probeFileByHash(filename, etag, size) {
      try {
          // 获取工兵 Token 和 Account 对象
          const { token, account } = await this.getWorkerToken();
          // 获取该工兵的缓存目录
          const parentID = await this.getCacheDirID(account, token);
          const safeName = filename.replace(/[\\/:*?"<>|]/g, "_").substring(0, 90);

          const res = await this.fetchJson(`${this.domain}/upload/v2/file/create`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
              body: JSON.stringify({ 
                  parentFileID: parentID, 
                  filename: safeName, 
                  etag, 
                  size: Number(size), 
                  duplicate: 2 // 自动重命名，无所谓，反正是垃圾文件
              })
          });

          return (res.code === 0 && res.data?.reuse === true);
      } catch (e) {
          console.warn(`[Probe Failed] ${e.message}`);
          return false;
      }
  }
}

export const core123 = new Core123Service();