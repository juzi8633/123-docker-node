// src/services/web123Client.js
import axios from 'axios';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { createLogger } from '../logger.js';

const logger = createLogger('WebClient');

export class Web123Client {
    /**
     * @param {Object} config - 配置对象
     */
    constructor(config) {
        this.passport = config.passport;
        this.password = config.password;
        this.role = config.role || 'worker';
        this.token = config.token || "";
        this.onTokenRefresh = config.onTokenRefresh || (async () => { });

        // [修复] 初始化登录锁，防止高并发下 Token 过期导致多次重复登录
        this.loginPromise = null;

        this.baseUrl = "https://www.123pan.com/b/api";
        this.loginBaseUrl = "https://login.123pan.com/api";

        this.request = axios.create({
            timeout: 30000,
            headers: {
                "platform": "web",
                "App-Version": "3",
            }
        });
        if (this.token) {
            this.setToken(this.token);
        }

        this._setupInterceptors();
    }

    setToken(token) {
        this.token = token;
        this.request.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    }

    _setupInterceptors() {
        // [新增] 请求拦截器：打印发出的请求，方便核对参数
        this.request.interceptors.request.use(config => {
            // 过滤掉太长的上传数据日志
            const debugData = config.url.includes('s3_upload_object') ? '[Binary Data]' : config.data;

            logger.info({
                method: config.method.toUpperCase(),
                url: config.url,
                headers: config.headers, 
                params: config.params,
                data: debugData
            }, `➡️ [Request Detail] 发起请求`);
            return config;
        }, error => Promise.reject(error));

        // [增强] 响应拦截器：打印服务器返回的一切
        this.request.interceptors.response.use(async (response) => {
            const res = response.data;
            const originalRequest = response.config;

            logger.info({
                url: originalRequest.url.replace(this.baseUrl, ''),
                code: res.code,
                msg: res.message,
                data: res.data
            }, `⬅️ [Response] 收到响应`);

            // 兼容 0 和 200 作为成功状态
            if (res.code === 0 || res.code === 200) return res;

            // 401 自动续期逻辑
            if (res.code === 401) {
                if (!originalRequest._retry) {
                    logger.warn({ passport: this.passport }, `⚠️ [API] Token 失效 (401)，正在自动续期...`);
                    originalRequest._retry = true;
                    try {
                        // [修复] 引入并发锁，确保同一时间只有一个登录请求在飞行中
                        if (!this.loginPromise) {
                            this.loginPromise = this.login().finally(() => {
                                this.loginPromise = null;
                            });
                        }
                        const newToken = await this.loginPromise;
                        
                        // 更新重试请求的 Token
                        originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
                        return this.request(originalRequest);
                    } catch (err) {
                        logger.error({ err: err.message }, `❌ [API] 自动续期失败`);
                        throw err;
                    }
                }
            }

            // 业务错误抛出
            const error = new Error(`[WebAPI Error] Code: ${res.code}, Msg: ${res.message}`);
            error.code = res.code;
            error.data = res.data;
            
            logger.warn({
                code: res.code,
                msg: res.message,
                data: res.data
            }, `❌ [API Business Error] 业务异常`);
            throw error;

        }, error => {
            // 网络层面的错误 (如 DNS 解析失败, 超时, 502/500 等)
            if (error.response) {
                logger.error({
                    status: error.response.status,
                    data: error.response.data
                }, `❌ [HTTP Error] 请求失败`);
            } else {
                logger.error({ err: error.message }, `❌ [Network Error] 网络异常`);
            }
            return Promise.reject(error);
        });
    }

    // ==========================================
    // 1. 认证模块
    // ==========================================

    async login() {
        if (!this.passport || !this.password) throw new Error("缺少账号密码配置");
        
        const url = `${this.baseUrl}/user/sign_in`;
        
        const payload = { 
            passport: this.passport, 
            password: this.password, 
            type: 1, 
            channel: "" 
        };
        
        try {
            logger.info({ passport: this.passport }, `🔑 [Login] 正在尝试登录 (PC模式)...`);
            
            // [注意] 使用 axios 原生实例，绕过拦截器，避免 401 死循环
            const data = await axios.post(url, payload, {
                headers: {
                    "platform": "web",
                    "App-Version": "3"
                }
            });
            
            const res = data.data;

            logger.info({ 
                code: res.code, 
                msg: res.message 
            }, `🔑 [Login] 登录接口响应`);

            if (res.code == 200 && res.data && res.data.token) {
                const newToken = res.data.token;
                this.setToken(newToken);
                
                // 同步更新 Cookie (部分接口可能需要)
                this.request.defaults.headers.common['Cookie'] = `sso-token=${newToken}`;
                
                if (this.onTokenRefresh) {
                    await this.onTokenRefresh(this.passport, newToken);
                }

                logger.info({ passport: this.passport }, `✅ 登录成功 (Token已刷新)`);
                return newToken;
            } else {
                throw new Error(`登录失败: ${res.message} (Code: ${res.code})`);
            }
        } catch (e) {
            logger.error({ passport: this.passport, err: e.message }, `❌ 登录请求异常`);
            throw e;
        }
    }

    // ==========================================
    // 2. 文件与目录模块
    // ==========================================

    async fsInfo(fileId) {
        const url = `${this.baseUrl}/file/info`;
        const payload = { fileIdList: [{ FileId: fileId }] };
        return await this.request.post(url, payload);
    }

    async fsList(parentFileId = 0, page = 1, limit = 100) {
        const url = `${this.baseUrl}/file/list`;
        const params = {
            driveId: 0, limit: limit, next: 0, orderBy: "file_id", orderDirection: "desc",
            parentFileId: parentFileId, Page: page, event: "homeListFile", trashed: false, inDirectSpace: false
        };
        return await this.request.get(url, { params });
    }

    async fsMkdir(name, parentId = 0) {
        return await this.uploadRequest({
            fileName: name,
            parentFileId: parentId,
            type: 1,
            size: 0,
            etag: "",
            duplicate: 0
        });
    }

    async fsTrash(fileIdList) {
        const url = `${this.baseUrl}/file/trash`;
        const ids = Array.isArray(fileIdList) ? fileIdList : [fileIdList];
        const payload = {
            fileTrashInfoList: ids.map(id => ({ FileId: id })),
            driveId: 0,
            event: "intoRecycle"
        };
        return await this.request.post(url, payload);
    }

    // ==========================================
    // 3. 上传与探测模块
    // ==========================================

    async uploadRequest(fileMeta) {
        const url = `${this.baseUrl}/file/upload_request`;
        const type = (fileMeta.size > 0 || fileMeta.etag) ? 0 : 1;

        const payload = {
            fileName: fileMeta.fileName,
            driveId: 0,
            duplicate: fileMeta.duplicate || 0,
            etag: fileMeta.etag || "",
            parentFileId: fileMeta.parentFileId || 0,
            size: fileMeta.size || 0,
            type: fileMeta.type !== undefined ? fileMeta.type : type,
            NotReuse: false
        };
        return await this.request.post(url, payload);
    }

    async _calcFileMd5(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('md5');
            const stream = fs.createReadStream(filePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', err => reject(err));
        });
    }

    async uploadFile(localPath, parentId = 0) {
        if (!fs.existsSync(localPath)) throw new Error(`文件不存在: ${localPath}`);

        const stat = fs.statSync(localPath);
        const fileName = path.basename(localPath);
        const size = stat.size;

        logger.info(`[Upload] 计算MD5: ${fileName}`);
        const md5 = await this._calcFileMd5(localPath);

        const checkResp = await this.uploadRequest({
            fileName, size, etag: md5, parentFileId: parentId, type: 0
        });

        if (checkResp.data.Reuse) {
            logger.info(`✅ [Upload] 秒传成功 (Reuse)`);
            return checkResp.data;
        }

        logger.info(`[Upload] 开始 S3 上传流...`);
        const initialData = checkResp.data;

        const authReqPayload = {
            bucket: initialData.bucket || initialData.Bucket,
            key: initialData.key || initialData.Key,
            storageNode: initialData.storageNode || initialData.StorageNode,
            uploadId: initialData.uploadId || initialData.UploadId || initialData.UploadID
        };

        const authUrl = `${this.baseUrl}/file/s3_upload_object/auth`;
        const authResp = await this.request.post(authUrl, authReqPayload);

        const authData = authResp.data;
        const presignedUrl = authData.presignedUrls ? authData.presignedUrls['1'] : null;

        if (!presignedUrl) throw new Error("无法获取 AWS S3 上传链接");

        const fileStream = fs.createReadStream(localPath);
        try {
            // S3 上传使用原生 Axios，不需要 123 的 Token
            await axios.put(presignedUrl, fileStream, {
                headers: {
                    'Content-Length': size,
                    'Content-Type': 'application/octet-stream'
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });
        } catch (err) {
            throw new Error(`S3 PUT 失败: ${err.message}`);
        }

        const completePayload = {
            FileId: 0,
            bucket: authData.bucket || authData.Bucket || authReqPayload.bucket,
            key: authData.key || authData.Key || authReqPayload.key,
            storageNode: authData.storageNode || authData.StorageNode || authReqPayload.storageNode,
            uploadId: authData.uploadId || authData.UploadId || authReqPayload.uploadId,
            isMultipart: false
        };

        const completeResp = await this.request.post(`${this.baseUrl}/file/upload_complete/v2`, completePayload);
        logger.info(`✅ [Upload] 上传完成`);
        return completeResp.data;
    }


    async getDownloadUrl(input, customUa = null) {
        let fileMeta = {};
        if (typeof input === 'string' || typeof input === 'number') {
            const infoResp = await this.fsInfo(input);
            const list = infoResp.data.infoList || infoResp.data.InfoList;
            if (!list || list.length === 0) throw new Error(`文件 ID ${input} 未找到`);
            const info = list[0];
            fileMeta = {
                etag: info.Etag,
                size: info.Size,
                filename: info.FileName,
                fileId: info.FileId,
                s3KeyFlag: info.S3KeyFlag
            };
        } else {
            fileMeta = input;
        }

        let s3KeyFlag = fileMeta.s3KeyFlag;

        // [补全] 只有在缺失 s3KeyFlag 时才进行探测
        if (!s3KeyFlag) {
            const probePayload = {
                fileName: ".tempfile_probe",
                duplicate: 2, // 2: 探测模式
                etag: fileMeta.etag,
                size: fileMeta.size,
                type: 0
            };
            try {
                const probeResp = await this.uploadRequest(probePayload);
                if (!probeResp.data.Reuse) {
                    throw new Error("无法获取 S3KeyFlag: 文件未在云端找到");
                }
                s3KeyFlag = probeResp.data.Info.S3KeyFlag;
            } catch (e) {
                logger.warn({ err: e.message, etag: fileMeta.etag }, `⚠️ [Link] S3KeyFlag 探测失败`);
                throw e;
            }
        }

        const downloadInfoPayload = {
            Etag: fileMeta.etag,
            Size: fileMeta.size,
            S3KeyFlag: s3KeyFlag,
            FileName: fileMeta.filename || String(fileMeta.etag),
            FileID: fileMeta.fileId || 0,
            driveId: 0,
            Type: 0
        };

        const config = {};
        if (customUa) {
            config.headers = { 'User-Agent': customUa };
        }

        const infoResp = await this.request.post(`${this.baseUrl}/v2/file/download_info`, 
            downloadInfoPayload, 
            config // ✅ 注入当前请求者的 UA
        );
        
        // 1. 安全提取 Host (优先取调度列表，兜底取返回的 downloadPath 里的域名)
        const dispatch = infoResp.data?.dispatchList?.[0] || infoResp.dispatchList?.[0];
        let host = dispatch?.prefix || "";

        let path = infoResp.data?.downloadPath || "";

        const finalUrl = `${host}${path}`;

        logger.info({ finalUrl }, `✅ 直链获取成功`);

        return finalUrl;
    }
}
