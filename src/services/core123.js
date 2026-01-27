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
    connections: 200,        // 最大并发连接数 (大幅提升秒传探测并发能力)
    pipelining: 1,           // HTTP/1.1 流水线
    connect: {
        timeout: 10000       // 连接超时 10秒
    }
});
setGlobalDispatcher(agent); // 应用到全局 fetch
// =========================================================================

// [新增] 简易日志工具 (仅用于打印，不影响业务)
function log(msg, data = null) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    const prefix = `[Core123 ${time}]`;
    if (data) {
        try {
            const str = JSON.stringify(data, null, 2);
            // 截断过长的日志防止刷屏
            console.log(`${prefix} ${msg}`, str.length > 2000 ? str.substring(0, 2000) + '... (truncated)' : str);
        } catch (e) {
            console.log(`${prefix} ${msg} [Object]`);
        }
    } else {
        console.log(`${prefix} ${msg}`);
    }
}

// [新增] 获取带偏移量的日期，格式 YYYY-MM-DD
// offset: 0=今天, -1=昨天, -2=前天
function getDatestamp(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
}

// =========================================================================
// [优化] 3. 缓存层面：使用 LRU 替代原生 Map，防止内存溢出
// =========================================================================
const memoryCache = new LRUCache({
    max: 1000,             // 最多缓存 1000 个 Token/Key
    ttl: 1000 * 60 * 60,   // 内存缓存 1 小时 (Redis 依然负责持久化)
});

// inflightRequests 用于请求去重，生命周期短，自清理，保持 Map 即可
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
    // 目录 ID 缓存前缀 (123:dir:client_id:folder_name)
    this.KEY_DIR_PREFIX = "123:dir:"; 
  }

  // [新增] 从数据库热重载配置
  async reloadConfig() {
    try {
        log('[Config] Loading configuration from DB...'); // [日志]
        
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
            log(`[Config] VIP Account Loaded: ${configMap.vip_id}`); // [日志]
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
        log(`[Config] Workers Loaded: ${this.workers.length}`); // [日志]

        // 兜底策略：如果没有工兵，VIP 兼职工兵 (风险较大，仅作Fallback)
        if (this.workers.length === 0 && this.vipAccount) {
            this.workers.push(this.vipAccount);
            log('[Config] No workers found, using VIP as worker fallback'); // [日志]
        }
        
        // 4. 设置根目录 ID
        this.rootFolderId = parseInt(configMap.root_folder_id || "0");
        if (isNaN(this.rootFolderId)) this.rootFolderId = 0;
        
        // 重置轮询索引
        this.workerIndex = 0;
        
        log(`[Config] Reload Complete. VIP: ${!!this.vipAccount}, Workers: ${this.workers.length}, RootDir: ${this.rootFolderId}`); // [日志]
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
        // log(`[API Request] ${options.method || 'GET'} ${url}`); // [日志] 可选开启
        // 由于设置了全局 Agent，这里的 fetch 会自动使用连接池
        const res = await fetch(url, { ...options, headers: optimizedHeaders });
        if (!res.ok) {
            const text = await res.text();
            log(`[API Error] HTTP ${res.status} for ${url}`, text); // [日志]
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
    // [优化] 使用 LRUCache API
    if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);
    
    const cached = await redis.get(cacheKey);
    if (cached) {
        memoryCache.set(cacheKey, cached);
        return cached;
    }

    log(`[Auth] Refreshing token for ${account.id}...`); // [日志]

    const url = `${this.domain}/api/v1/access_token`;
    const data = await this.fetchJson(url, {
        method: "POST",
        headers: { "Platform": this.platform, "Content-Type": "application/json" },
        body: JSON.stringify({ clientID: account.id, clientSecret: account.secret })
    });

    if (data.code !== 0) {
        log(`[Auth] Failed:`, data); // [日志]
        throw new Error(`Token Error (${account.id}): ${data.message}`);
    }
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

  // === [修改] 获取/创建 带日期的缓存目录 (日期隔离策略) ===
  // 每个账号（VIP或工兵）都有自己的缓存目录 ID，存入 Redis
  async getCacheDirID(account, token) {
      // 1. 生成当天的目录名，例如 "123_Node_Cache_2026-01-25"
      // 这样每天都会创建一个新目录，彻底物理隔离，防止并发冲突
      const baseName = account.role === 'vip' ? this.VIP_CACHE_NAME : this.WORKER_CACHE_NAME;
      const folderName = `${baseName}_${getDatestamp(0)}`; 
      
      // Redis Key 也带上目录名，确保唯一性: "123:dir:clientID:folderName"
      const redisKey = `${this.KEY_DIR_PREFIX}${account.id}:${folderName}`;
      
      const cachedId = await redis.get(redisKey);
      if (cachedId) return parseInt(cachedId);

      const parentId = account.role === 'vip' ? this.rootFolderId : 0;

      // 2. 尝试创建
      log(`[Dir] Creating/Checking folder '${folderName}' under ${parentId} for ${account.id}`); 

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
          // 已存在，反查 ID (为了获取 ID 存入 Redis)
          // 注意：这里的 list 是为了获取 ID，范围很小（精准匹配），不算全盘扫描
          log(`[Dir] Folder exists, searching ID...`); 
          const listRes = await this.fetchJson(`${this.domain}/api/v1/file/list?parentFileId=${parentId}&page=1&limit=100`, {
              method: "GET",
              headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform }
          });
          if (listRes.code === 0 && listRes.data?.fileList) {
              const target = listRes.data.fileList.find(f => f.filename === folderName && f.type === 1);
              if (target) {
                  dirID = target.fileID;
                  log(`[Dir] Found existing folder ID: ${dirID}`); 
              }
          }
      } else {
          log(`[Dir] mkdir failed:`, createRes); 
      }

      if (dirID > 0) {
          // [关键修改] 设置 3 天 (259200秒) 过期
          // 确保"昨天"甚至"前天"的 ID 在 Redis 里一定还在，方便清理任务精准读取
          await redis.set(redisKey, String(dirID), 'EX', 259200);
          return dirID;
      }
      log(`[Dir] Failed to resolve Dir ID, fallback to ParentID: ${parentId}`); 
      return parentId; // 降级到根目录
  }

  // === [修改] 精准清理"昨天"的目录 (不扫描网盘，只查 Redis) ===
  // 策略：计算出"昨天"的目录名 -> 查 Redis -> 有 ID 就删 -> 没 ID 就算了
  async recycleAllCacheFolders() {
      console.log('🧹 [Cleanup] Starting targeted date cleanup...');
      
      // 每次清理前刷新一次配置，确保清理的是最新账号
      await this.reloadConfig();

      const accounts = [];
      if (this.vipAccount) accounts.push(this.vipAccount);
      accounts.push(...this.workers);
      
      // 去重（防止 VIP 也在 workers 里）
      const uniqueAccounts = [...new Map(accounts.map(item => [item.id, item])).values()];

      // 我们清理"昨天"和"前天"的，以防万一昨天的任务失败了
      // 这里的开销极小，只是读两次 Redis
      const targetOffsets = [-1, -2]; 

      for (const acc of uniqueAccounts) {
          try {
              const token = await this.getTokenForAccount(acc);
              const baseName = acc.role === 'vip' ? this.VIP_CACHE_NAME : this.WORKER_CACHE_NAME;

              for (const offset of targetOffsets) {
                  const targetDate = getDatestamp(offset); // 获取 "2026-01-24"
                  const targetFolderName = `${baseName}_${targetDate}`;
                  const redisKey = `${this.KEY_DIR_PREFIX}${acc.id}:${targetFolderName}`;
                  
                  // 1. 直接问 Redis：昨天那个目录 ID 是多少？
                  const dirId = await redis.get(redisKey);
                  
                  if (dirId) {
                      log(`[Cleanup] Found expired folder in Redis: ${targetFolderName} (ID: ${dirId})`);
                      
                      // 2. 精准删除该 ID
                      const res = await this.fetchJson(`${this.domain}/api/v1/file/trash`, {
                          method: "POST",
                          headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
                          body: JSON.stringify({ fileIds: [parseInt(dirId)] })
                      });

                      if (res.code === 0 || res.code === 404) { // 成功或已不存在
                          console.log(`✅ [Cleanup] Recycled: ${targetFolderName}`);
                          // 3. 删除 Redis Key (任务完成)
                          await redis.del(redisKey);
                      } else {
                          console.warn(`⚠️ [Cleanup] Failed to trash ${dirId}: ${res.message}`);
                          log(`[Cleanup] Fail response:`, res); 
                      }
                  } else {
                       // Redis 里没有，说明昨天没创建或者已经清理过了，安全跳过
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

    if (inflightRequests.has(etag)) {
        log(`[GetLink] Joining inflight request for ${filename}`); // [日志]
        return inflightRequests.get(etag);
    }

    const task = (async () => {
        try {
            log(`[GetLink] Start for: ${filename} (${etag})`); // [日志]
            
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

            log(`[GetLink] Probe Result (VIP):`, createRes); // [日志] 关键点：查看秒传结果

            if (createRes.code !== 0 || !createRes.data?.reuse) {
                throw new Error(`VIP秒传失败: ${safeName} (Code: ${createRes.code}, Reuse: ${createRes.data?.reuse})`);
            }

            const fileID = createRes.data.fileID;

            // 2. 获取直链
            const downRes = await this.fetchJson(`${this.domain}/api/v1/file/download_info?fileId=${fileID}`, {
                method: "GET",
                headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform }
            });

            log(`[GetLink] DownloadInfo Result:`, downRes); // [日志] 关键点：查看直链结果

            if (downRes.code !== 0) throw new Error(`直链失败: ${downRes.message}`);
            const url = downRes.data.downloadUrl;

            // 缓存 6 天 (符合你的需求)
            if (url) await redis.set(redisKey, url, 'EX', 518400); 
            log(`[GetLink] Success: ${url.slice(0, 50)}...`); // [日志]
            return url;
        } finally {
            inflightRequests.delete(etag);
        }
    })();

    inflightRequests.set(etag, task);
    return task;
  }

  // === 工兵探测 (无删除) ===
  async probeFileByHash(filename, hash, size) {
      try {
          // 获取工兵 Token 和 Account 对象
          const { token, account } = await this.getWorkerToken();
          // 获取该工兵的缓存目录
          const parentID = await this.getCacheDirID(account, token);
          const safeName = filename.replace(/[\\/:*?"<>|]/g, "_").substring(0, 255); // 123限制255字符

          log(`[Probe] Worker ${account.id} checking: ${safeName} (HashLen: ${hash.length})`);

          let res;
          
          // [新增] 自动判断 Hash 类型
          if (hash.length === 40) {
              // === SHA1 模式 (115专享) ===
              // API: /upload/v2/file/sha1_reuse
              res = await this.fetchJson(`${this.domain}/upload/v2/file/sha1_reuse`, {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
                  body: JSON.stringify({ 
                      parentFileID: parentID, 
                      filename: safeName, 
                      sha1: hash, 
                      size: Number(size), 
                      duplicate: 2 // 覆盖
                  })
              });
              
              // 123的新接口返回结构: { code: 0, data: { reuse: true/false, fileID: ... } }
              log(`[Probe SHA1] API Response:`, res);
              return (res.code === 0 && res.data?.reuse === true);

          } else {
              // === MD5 模式 (原有逻辑) ===
              // API: /upload/v2/file/create
              res = await this.fetchJson(`${this.domain}/upload/v2/file/create`, {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
                  body: JSON.stringify({ 
                      parentFileID: parentID, 
                      filename: safeName, 
                      etag: hash, 
                      size: Number(size), 
                      duplicate: 2 
                  })
              });

              log(`[Probe MD5] API Response:`, res);
              return (res.code === 0 && res.data?.reuse === true);
          }

      } catch (e) {
          console.warn(`[Probe Failed] ${e.message}`);
          return false;
      }
  }
}

export const core123 = new Core123Service();