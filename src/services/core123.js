// src/services/core123.js
import redis from '../redis.js';
import dotenv from 'dotenv'; // 👈 关键修复
dotenv.config();

// 内存一级缓存 (Hot Cache) - 保持不变，减少 Redis 网络 IO
const memoryCache = new Map();
// 简单的内存去重锁
const inflightRequests = new Map();

export class Core123Service {
  constructor() {
    this.domain = "https://open-api.123pan.com";
    this.platform = "open_platform";
    this.clientId = process.env.CLIENT_ID;
    this.clientSecret = process.env.CLIENT_SECRET;
    this.rootFolderId = parseInt(process.env.ROOT_FOLDER_ID || "0");
    
    // Redis Keys 前缀
    this.KEY_TOKEN = "123:access_token";
    this.KEY_DIR_ID = "123:current_dir_id";
    this.KEY_DLINK_PREFIX = "123:dlink:";
  }

  // 封装 fetch，自动处理 User-Agent 和 JSON 解析
  async fetchJson(url, options) {
    const optimizedHeaders = {
        ...options.headers,
        "Connection": "keep-alive",
        "User-Agent": "Mozilla/5.0 (Node.js; Docker) 123-Node-Server/1.0"
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

  // === 核心实现：获取 Access Token (Redis版) ===
  async getAccessToken() {
    // 1. 查一级内存缓存
    if (memoryCache.has('token')) return memoryCache.get('token');

    // 2. 查 Redis (原生 get)
    const cachedToken = await redis.get(this.KEY_TOKEN);
    if (cachedToken) {
        memoryCache.set('token', cachedToken);
        return cachedToken;
    }

    // 3. 调用 API 刷新
    if (!this.clientId || !this.clientSecret) {
        throw new Error("Missing CLIENT_ID/CLIENT_SECRET env vars");
    }

    const url = `${this.domain}/api/v1/access_token`;
    const data = await this.fetchJson(url, {
      method: "POST",
      headers: { "Platform": this.platform, "Content-Type": "application/json" },
      body: JSON.stringify({ clientID: this.clientId, clientSecret: this.clientSecret })
    });

    if (data.code !== 0) throw new Error(`Token Error: ${data.message}`);

    const token = data.data.accessToken;
    const expiredIn = data.data.expired_in || 2592000; // 默认30天
    
    // 4. 写入 Redis (原生 set, EX 设置过期秒数)
    // 提前 1 小时过期，确保安全
    await redis.set(this.KEY_TOKEN, token, 'EX', expiredIn - 3600);
    
    memoryCache.set('token', token);
    return token;
  }

  // === 核心实现：获取每日缓存目录 ID (Redis版) ===
  async getUploadParentID() {
    // 1. 查 Redis
    const cachedId = await redis.get(this.KEY_DIR_ID);
    if (cachedId) return parseInt(cachedId);

    // 2. 如果 Redis 没数据，返回根目录 ID (或者可以去 API 查，这里简化逻辑)
    return this.rootFolderId;
  }

  // 创建文件夹 API
  async mkdir(name, parentID) {
    const token = await this.getAccessToken();
    const res = await this.fetchJson(`${this.domain}/upload/v1/file/mkdir`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
      body: JSON.stringify({ name, parentID })
    });
    if (res.code !== 0) throw new Error(res.message);
    return res.data.dirID;
  }

  // === 核心实现：每日轮替逻辑 (Redis版) ===
  async rotateDailyCache() {
    // 计算东八区明天的日期（因为通常在凌晨跑）
    const todayStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().split('T')[0];
    const newDirName = `Cache_${todayStr}`;
    console.log(`[Rotate] Creating daily dir: ${newDirName}`);
    
    try {
      const newDirID = await this.mkdir(newDirName, this.rootFolderId);
      
      // 写入 Redis，永不过期（直到下次轮替覆盖）
      await redis.set(this.KEY_DIR_ID, String(newDirID));
      
      return { success: true, newDirID };
    } catch (e) {
      console.error(`[Rotate] Failed:`, e);
      return { success: false, error: e.message };
    }
  }

  // === 核心实现：获取直链 (Redis版) ===
  async getDownloadUrlByHash(filename, etag, size) {
    const redisKey = `${this.KEY_DLINK_PREFIX}${etag}`;

    // 1. 查 Redis 缓存
    const cachedUrl = await redis.get(redisKey);
    if (cachedUrl) return cachedUrl;

    // 防止缓存击穿：如果同一个 etag 正在请求中，复用 Promise
    if (inflightRequests.has(etag)) return inflightRequests.get(etag);

    const task = (async () => {
      try {
        const token = await this.getAccessToken();
        const parentID = await this.getUploadParentID();
        
        let safeFilename = filename.replace(/[\\/:*?"<>|]/g, "_");
        if (safeFilename.length > 100) safeFilename = safeFilename.substring(0, 90);

        // 步骤 A: 尝试创建文件 (秒传检测)
        const createRes = await this.fetchJson(`${this.domain}/upload/v2/file/create`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform, "Content-Type": "application/json" },
            body: JSON.stringify({ 
                parentFileID: parentID, 
                filename: safeFilename, 
                etag, 
                size: Number(size), 
                duplicate: 1 // 1: 允许重复创建(为了获取ID)
            })
        });

        if (createRes.code !== 0) throw new Error(`123 API Error: ${createRes.message}`);
        // 关键：必须复用成功 (reuse: true) 才能直接获取直链
        if (!createRes.data?.reuse) throw new Error(`云端无此文件 (Hash未命中)，请先上传: ${safeFilename}`);

        const fileID = createRes.data.fileID;

        // 步骤 B: 调用 API 获取 CDN 直链
        const downRes = await this.fetchJson(`${this.domain}/api/v1/file/download_info?fileId=${fileID}`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${token}`, "Platform": this.platform }
        });

        if (downRes.code !== 0) throw new Error(`获取下载地址失败: ${downRes.message}`);

        const finalCdnUrl = downRes.data.downloadUrl;
        
        if (finalCdnUrl && finalCdnUrl.startsWith("http")) {
            // 写入 Redis，缓存 5 天 (432000秒)
            await redis.set(redisKey, finalCdnUrl, 'EX', 432000);
        }
        return finalCdnUrl;
      } finally {
        inflightRequests.delete(etag);
      }
    })();

    inflightRequests.set(etag, task);
    return task;
  }
}

export const core123 = new Core123Service();