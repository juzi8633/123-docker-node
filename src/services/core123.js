// src/services/core123.js
import redis from '../redis.js';
import { prisma } from '../db.js';
import { Web123Client } from './web123Client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Core123');

// 防惊群 Map (Inflight Request Lock)
// 用于防止高并发下对同一文件重复发起获取直链的请求
const inflightRequests = new Map();

const KEY_DLINK_PREFIX = "123:dlink:";
const KEY_DIR_PREFIX = "123:dir:";
const KEY_TOKEN_PREFIX = "123:token:"; // Token 缓存前缀
const VIP_CACHE_NAME = "123_Node_Cache"; // 缓存目录前缀

function getDatestamp(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
}

export class Core123Service {
  constructor() {
    this.vipClient = null;     // VIP 客户端 (负责下载/存储/离线)
    this.workerClients = [];   // 工兵客户端池 (负责探测/秒传验证)
    this.workerIndex = 0;
  }

  /**
   * Token 回调：当 Web123Client 内部刷新 Token 时调用
   */
  async _handleTokenRefresh(passport, newToken) {
      if (!passport || !newToken) return;
      const key = `${KEY_TOKEN_PREFIX}${passport}`;
      // Token 存 7 天
      await redis.set(key, newToken, 'EX', 604800);
      logger.debug({ passport }, `[Core] Token 已更新至 Redis`);
  }

  /**
   * 加载配置并初始化客户端池
   */
  async reloadConfig() {
    try {
        logger.info('🔍 [Config] 开始加载 WebAPI 账号配置...');

        const targetKeys = ['account_vip', 'account_workers'];
        const configs = await prisma.systemConfig.findMany({
            where: { key: { in: targetKeys } }
        });

        logger.info({
            foundCount: configs.length,
            keysFound: configs.map(c => c.key)
        }, '🔍 [Config] 数据库查询结果');

        if (configs.length === 0) {
            logger.error('❌ [Config] 严重错误：数据库中未找到任何账号配置！');
        }

        const configMap = configs.reduce((acc, cur) => ({ ...acc, [cur.key]: cur.value }), {});
        const tokenSaveCallback = this._handleTokenRefresh.bind(this);

        // 1. 初始化 VIP Client
        if (configMap.account_vip) {
            const parts = configMap.account_vip.split(':');
            if (parts.length >= 2) {
                const passport = parts[0];
                const password = parts[1];
                const cachedToken = await redis.get(`${KEY_TOKEN_PREFIX}${passport}`);

                this.vipClient = new Web123Client({
                    passport, password, role: 'vip',
                    token: cachedToken || "",
                    onTokenRefresh: tokenSaveCallback
                });
                logger.info(`🔍 [Config] 主账号已加载: ${passport}`);
            }
        } else {
            logger.warn('⚠️ [Config] 缺少 account_vip 配置！');
        }

        // 2. 初始化 Worker Clients
        this.workerClients = [];
        if (configMap.account_workers) {
            const list = configMap.account_workers.split(',');
            for (const item of list) {
                const parts = item.split(':');
                if (parts.length >= 2) {
                    const passport = parts[0].trim();
                    const password = parts[1].trim();
                    const cachedToken = await redis.get(`${KEY_TOKEN_PREFIX}${passport}`);

                    const client = new Web123Client({
                        passport, password, role: 'worker',
                        token: cachedToken || "",
                        onTokenRefresh: tokenSaveCallback
                    });
                    this.workerClients.push(client);
                }
            }
            logger.info({ count: this.workerClients.length }, `🔍 [Config] 工兵账号加载完成`);
        }

        // 降级策略
        if (this.workerClients.length === 0 && this.vipClient) {
            this.workerClients.push(this.vipClient);
            logger.info(`⚠️ 未配置工兵账号，将使用 VIP 账号执行探测`);
        }

    } catch (e) {
        logger.error({ err: e.message }, `❌ 配置重载发生异常`);
    }
  }

  async initLinkCacheFolder() {
      try {
          if (!this.vipClient) await this.reloadConfig();
          if (this.vipClient) {
              const dirId = await this.getCacheDirID(this.vipClient, VIP_CACHE_NAME);
              logger.info({ dirId }, `[Init] 缓存目录初始化完成`);
          }
      } catch (e) {
          logger.warn({ err: e.message }, `[Init] 缓存目录初始化遇到非致命错误`);
      }
  }

  async getVipClient() {
      if (!this.vipClient) await this.reloadConfig();
      if (!this.vipClient) throw new Error("VIP 账号未配置");
      return this.vipClient;
  }

  async getWorkerClient() {
      if (this.workerClients.length === 0) await this.reloadConfig();
      if (this.workerClients.length === 0) throw new Error("无可用的 123 账号");
      const client = this.workerClients[this.workerIndex];
      this.workerIndex = (this.workerIndex + 1) % this.workerClients.length;
      return client;
  }

  // =======================================================
  // 核心业务 1: 获取下载直链 (带缓存与防抖)
  // =======================================================
  async getDownloadUrlByHash(filename, etag, size, S3KeyFlag, userAgent) {
    const redisKey = `${KEY_DLINK_PREFIX}${etag}`;

    // 1. 查缓存
    const cachedUrl = await redis.get(redisKey);
    if (cachedUrl) return cachedUrl;

    // 2. 查并发锁
    if (inflightRequests.has(etag)) return inflightRequests.get(etag);

    // 3. 执行请求
    const task = (async () => {
        try {
            let targetS3Key = S3KeyFlag;
            if (!targetS3Key) {
                const probeResult = await this.probeFileByHash(filename, etag, size); // 使用 Worker 账号
                if (!probeResult || !probeResult.S3KeyFlag) {
                    throw new Error("文件不存在或探测失败");
                }
                if (probeResult && probeResult.S3KeyFlag) {
                    targetS3Key = probeResult.S3KeyFlag;

                    // 4. 【异步更新数据库】将探测到的 S3KeyFlag 持久化，下次请求直接走 VIP
                    prisma.seriesEpisode.updateMany({
                      where: { etag: etag },
                      data: { S3KeyFlag: targetS3Key }
                    }).then(res => {
                      logger.info({ etag, count: res.count }, `💾 [DB] S3KeyFlag 已回填数据库`);
                    }).catch(err => {
                      logger.warn({ err: err.message }, `⚠️ [DB] S3KeyFlag 回填失败`);
                    });
                }
                logger.info({ targetS3Key }, `✅ 普通账号获取直链`);
            }
            const client = await this.getVipClient();

            const url = await client.getDownloadUrl({
                etag, size: Number(size), filename, S3KeyFlag: targetS3Key
            }, userAgent);

            if (url) {
                // 缓存 6 天
                await redis.set(redisKey, url, 'EX', 518400);
            }
            return url;
        } catch (e) {
            logger.error({ err: e.message, filename }, `[Link] 获取直链失败`);
            throw e;
        } finally {
            inflightRequests.delete(etag);
        }
    })();

    inflightRequests.set(etag, task);
    return task;
  }

  // =======================================================
  // 核心业务 2: 秒传探测
  // =======================================================
  async probeFileByHash(filename, etag, size) {
      try {
          const client = await this.getWorkerClient();
          const safeName = filename.replace(/[\\/:*?"<>|]/g, "_").substring(0, 255);
          const fileMeta = {
              fileName: '.tempfile', size: Number(size), duplicate: 2, etag, type: 0
          };

          await new Promise(r => setTimeout(r, 1000)); // 简易限流

          const res = await client.uploadRequest(fileMeta);
          if (res.code === 0 && res.data && res.data.Reuse) {
              const result = { reuse: true };
              if (res.data.Info?.S3KeyFlag) {
                  result.S3KeyFlag = res.data.Info.S3KeyFlag;
              }
              return result;
          }
          return false;
      } catch (e) {
          logger.warn({ err: e.message, filename}, `[Probe] 探测异常`);
          return false;
      }
  }

  // =======================================================
  // 核心业务 3: 目录管理
  // =======================================================
  async getCacheDirID(client, baseName) {
      const folderName = `${baseName}_${getDatestamp(0)}`;
      const accountId = client.passport;
      const redisKey = `${KEY_DIR_PREFIX}${accountId}:${folderName}`;

      const cachedId = await redis.get(redisKey);
      if (cachedId) return parseInt(cachedId);

      try {
          const mkRes = await client.fsMkdir(folderName, 0);
          let dirID = 0;
          if (mkRes.code === 0 && mkRes.data) {
              dirID = mkRes.data.Info ? mkRes.data.Info.FileId : mkRes.data.FileId;
          }
          if (!dirID) {
             const listRes = await client.fsList(0, 1, 50);
             const target = listRes.data?.InfoList?.find(f => f.FileName === folderName && f.Type === 1);
             if (target) dirID = target.FileId;
          }

          if (dirID > 0) {
              await redis.set(redisKey, String(dirID), 'EX', 259200);
              this.recycleAllCacheFolders().catch(() => {}); // 异步清理旧目录
              return dirID;
          }
      } catch (e) {
          logger.error({ err: e.message }, `获取缓存目录失败`);
      }
      return 0;
  }

  async recycleAllCacheFolders() {
      if (!this.vipClient) return;
      const targetOffsets = [-1, -2];
      for (const offset of targetOffsets) {
          const folderName = `${VIP_CACHE_NAME}_${getDatestamp(offset)}`;
          const redisKey = `${KEY_DIR_PREFIX}${this.vipClient.passport}:${folderName}`;
          const dirId = await redis.get(redisKey);
          if (dirId) {
              try {
                //   await this.vipClient.fsTrash(parseInt(dirId));
                  await redis.del(redisKey);
                  logger.info({ folder: folderName }, `[清理] 旧目录已移入回收站`);
              } catch (e) {}
          }
      }
  }


  async uploadFile(localPath) {
      const client = await this.getVipClient();
      const parentID = await this.getCacheDirID(client, VIP_CACHE_NAME);
      return await client.uploadFile(localPath, parentID);
  }

  // 辅助方法：暴露 Token 给某些特殊需求（如查询进度）
  async getVipToken() {
      const client = await this.getVipClient();
      return client.token;
  }

  async getUploadParentID() {
      const client = await this.getVipClient();
      return await this.getCacheDirID(client, VIP_CACHE_NAME);
  }
}

export const core123 = new Core123Service();
