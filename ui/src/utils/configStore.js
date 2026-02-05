// src/utils/configStore.js
import { reactive } from 'vue';

// 全局响应式配置对象
export const globalConfig = reactive({
    tmdbKey: '',
    quarkCookie: '',
    account_vip: '',
    workerAccounts: '',
    open123DirId: '',
    rootFolderId: '',
    cloud189Token: '', 
    isLoaded: false
});

export async function initConfig() {
    try {
        const res = await fetch('./api/config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const json = await res.json();
        
        if (json.success && json.data) {
            const d = json.data;
            // 映射数据库 keys 到前端变量
            globalConfig.tmdbKey = d.tmdb_key || '';
            globalConfig.quarkCookie = d.quark_cookie || '';
            globalConfig.account_vip = d.account_vip || '';
            globalConfig.workerAccounts = d.account_workers || '';
            globalConfig.open123DirId = d.open123_dir_id || '';
            globalConfig.rootFolderId = d.root_folder_id || '';
            globalConfig.cloud189Token = d.cloud189_token || '';
            globalConfig.isLoaded = true;
            console.log('[ConfigStore] Configuration loaded from backend');
        }
    } catch (e) {
        console.error('[ConfigStore] Failed to load config:', e);
    }
}