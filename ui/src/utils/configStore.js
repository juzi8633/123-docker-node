// src/utils/configStore.js
import { reactive } from 'vue';

// 全局响应式配置对象
// 组件中直接引入此对象即可获取最新配置，无需读 localStorage
export const globalConfig = reactive({
    tmdbKey: '',
    quarkCookie: '',
    vipId: '',
    vipSecret: '',
    workerAccounts: '',
    open123DirId: '',  // 123盘目标存储目录ID
    rootFolderId: '',  // 后端缓存根目录ID
    isLoaded: false    // 加载状态标记
});

/**
 * 从后端 API 初始化/刷新配置
 * 通常在 App.vue 挂载时或 ConfigPanel 保存后调用
 */
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
            globalConfig.vipId = d.vip_id || '';
            globalConfig.vipSecret = d.vip_secret || '';
            globalConfig.workerAccounts = d.worker_accounts || '';
            globalConfig.open123DirId = d.open123_dir_id || '';
            globalConfig.rootFolderId = d.root_folder_id || '';
            
            globalConfig.isLoaded = true;
            console.log('[ConfigStore] Configuration loaded from backend');
        }
    } catch (e) {
        console.error('[ConfigStore] Failed to load config:', e);
        // 可以考虑在这里加个 toast 提示，但为了避免循环依赖，暂时只打印日志
    }
}