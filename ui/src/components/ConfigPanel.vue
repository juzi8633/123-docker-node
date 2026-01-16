<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { showToast } from '../utils/toast.js'
import { globalConfig, initConfig } from '../utils/configStore.js'

const emit = defineEmits(['close'])
const isSaving = ref(false)

const form = ref({
    tmdb_key: '',
    quark_cookie: '',
    vip_id: '',
    vip_secret: '',
    worker_accounts: '',
    open123_dir_id: '',
    root_folder_id: '',
    // [新增] 本地表单增加 189 token
    cloud189_token: '', 
    emby_config: {
        host: '',
        api_key: '',
        enabled: false
    },
    frontend_verify_interval: 3
})

onMounted(() => {
    form.value.tmdb_key = globalConfig.tmdbKey || ''
    form.value.quark_cookie = globalConfig.quarkCookie || ''
    form.value.vip_id = globalConfig.vipId || ''
    form.value.vip_secret = globalConfig.vipSecret || ''
    form.value.worker_accounts = globalConfig.workerAccounts || ''
    form.value.open123_dir_id = globalConfig.open123DirId || ''
    form.value.root_folder_id = globalConfig.rootFolderId || ''
    // [新增] 初始化赋值
    form.value.cloud189_token = globalConfig.cloud189Token || ''
    
    if (globalConfig.embyConfig) {
        form.value.emby_config = { ...globalConfig.embyConfig }
    }

    form.value.frontend_verify_interval = parseInt(localStorage.getItem('frontend_verify_interval') || '3')

    document.body.style.overflow = 'hidden'
})

onUnmounted(() => {
    document.body.style.overflow = ''
})

const handleSave = async () => {
    isSaving.value = true
    try {
        localStorage.setItem('frontend_verify_interval', form.value.frontend_verify_interval)

        const apiPayload = {
            configs: {
                tmdb_key: form.value.tmdb_key,
                quark_cookie: form.value.quark_cookie,
                vip_id: form.value.vip_id,
                vip_secret: form.value.vip_secret,
                worker_accounts: form.value.worker_accounts,
                open123_dir_id: form.value.open123_dir_id,
                root_folder_id: form.value.root_folder_id,
                // [新增] 提交 189 token
                cloud189_token: form.value.cloud189_token,
                emby_config: JSON.stringify(form.value.emby_config)
            }
        }

        const res = await fetch('./api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(apiPayload)
        })
        
        const json = await res.json()
        if (!json.success) throw new Error(json.message)

        await initConfig()

        showToast("配置已保存并热重载生效", "success")
        emit('close')

    } catch (e) {
        console.error(e)
        showToast("保存失败: " + e.message, "error")
    } finally {
        isSaving.value = false
    }
}
</script>

<template>
  <div class="h-full overflow-hidden flex flex-col bg-white">
      
    <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0 bg-white/80 backdrop-blur z-20">
        <div>
            <h2 class="text-lg font-bold text-slate-800 tracking-tight">系统设置</h2>
            <p class="text-xs text-slate-400 font-medium">配置 API 密钥、账号连接与自动化参数</p>
        </div>
        <button @click="$emit('close')" class="w-8 h-8 rounded-full bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 flex items-center justify-center transition-colors shadow-sm ring-1 ring-slate-900/5">
            <i class="fa-solid fa-times text-sm"></i>
        </button>
    </div>

    <div class="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
        
        <div class="space-y-3">
            <div class="flex items-center gap-2 text-indigo-600 font-bold text-xs uppercase tracking-wider px-1">
                <i class="fa-solid fa-film"></i>
                <h3>元数据刮削 (TMDB)</h3>
            </div>
            <div class="bg-slate-50 p-4 rounded-xl border border-slate-100/60 shadow-sm focus-within:ring-2 focus-within:ring-indigo-500/10 focus-within:border-indigo-200 transition-all">
                <label class="block text-xs font-bold text-slate-500 mb-1.5">API Read Access Token / API Key</label>
                <div class="relative">
                    <i class="fa-solid fa-key absolute left-3 top-1/2 -translate-y-1/2 text-slate-300 text-xs"></i>
                    <input type="text" v-model="form.tmdb_key" placeholder="输入 TMDB API Key" 
                        class="w-full pl-8 pr-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-indigo-400 transition-all font-mono placeholder:text-slate-300">
                </div>
            </div>
        </div>

        <div class="space-y-3">
            <div class="flex items-center gap-2 text-blue-600 font-bold text-xs uppercase tracking-wider px-1">
                <i class="fa-solid fa-cloud"></i>
                <h3>123 网盘 (核心)</h3>
            </div>
            <div class="bg-blue-50/30 p-4 rounded-xl border border-blue-100/60 space-y-4">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div class="space-y-1.5">
                        <label class="block text-xs font-bold text-slate-500">ClientID (VIP)</label>
                        <input type="text" v-model="form.vip_id" placeholder="开放平台 ClientID" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-400 font-mono">
                    </div>
                    <div class="space-y-1.5">
                        <label class="block text-xs font-bold text-slate-500">ClientSecret (VIP)</label>
                        <input type="password" v-model="form.vip_secret" placeholder="••••••••••••" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-400 font-mono">
                    </div>
                </div>
                <div class="space-y-1.5">
                    <label class="block text-xs font-bold text-slate-500">工兵账号池 (Workers)</label>
                    <textarea v-model="form.worker_accounts" rows="3" placeholder="ID:Secret,ID:Secret" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700 outline-none focus:border-blue-400 resize-none font-mono"></textarea>
                </div>
                 <div class="grid grid-cols-2 gap-4">
                     <div class="space-y-1.5">
                        <label class="block text-xs font-bold text-slate-500">目标存储目录 ID</label>
                        <input type="text" v-model="form.open123_dir_id" placeholder="0" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-400 font-mono">
                    </div>
                     <div class="space-y-1.5">
                        <label class="block text-xs font-bold text-slate-500">后端缓存根目录 ID</label>
                        <input type="text" v-model="form.root_folder_id" placeholder="0" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-400 font-mono">
                    </div>
                </div>
            </div>
        </div>

        <div class="space-y-3">
            <div class="flex items-center gap-2 text-orange-600 font-bold text-xs uppercase tracking-wider px-1">
                <i class="fa-solid fa-cloud-sun"></i>
                <h3>天翼云盘 (189)</h3>
            </div>
            <div class="bg-orange-50/30 p-4 rounded-xl border border-orange-100/60 shadow-sm">
                <label class="block text-xs font-bold text-slate-500 mb-1.5">Access Token</label>
                <textarea v-model="form.cloud189_token" rows="2" placeholder="输入天翼云盘 AccessToken (用于解析直链)" 
                    class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-50 transition-all font-mono custom-scrollbar resize-none"></textarea>
                <p class="text-[10px] text-slate-400 mt-2">
                    对应 Redis Key: <code class="bg-slate-100 px-1 rounded text-slate-500">auth:189:token</code>。留空则需要后台服务自动刷新。
                </p>
            </div>
        </div>

        <div class="space-y-3">
            <div class="flex items-center gap-2 text-emerald-600 font-bold text-xs uppercase tracking-wider px-1">
                <i class="fa-solid fa-cookie-bite"></i>
                <h3>夸克 Cookie</h3>
            </div>
            <div class="bg-emerald-50/30 p-4 rounded-xl border border-emerald-100/60 shadow-sm">
                <label class="block text-xs font-bold text-slate-500 mb-1.5">Cookie</label>
                <textarea v-model="form.quark_cookie" rows="2" placeholder="输入夸克网页版 Cookie" 
                    class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-50 transition-all font-mono custom-scrollbar resize-none"></textarea>
            </div>
        </div>

        <div class="space-y-3">
            <div class="flex items-center gap-2 text-violet-600 font-bold text-xs uppercase tracking-wider px-1">
                <i class="fa-solid fa-play-circle"></i>
                <h3>Emby 媒体库通知</h3>
            </div>
            <div class="bg-violet-50/30 p-4 rounded-xl border border-violet-100/60 shadow-sm" :class="{'opacity-80': !form.emby_config.enabled}">
                <div class="flex items-center justify-between pb-3 mb-3 border-b border-violet-100/50">
                    <label class="text-xs font-bold text-slate-600">启用自动刷新</label>
                    <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" v-model="form.emby_config.enabled" class="sr-only peer">
                        <div class="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-violet-500"></div>
                    </label>
                </div>
                <div class="space-y-4" v-if="form.emby_config.enabled || true" :class="{'opacity-50 pointer-events-none filter blur-[1px]': !form.emby_config.enabled}">
                    <div class="space-y-1.5">
                        <label class="block text-xs font-bold text-slate-500">Emby Host</label>
                        <input type="text" v-model="form.emby_config.host" placeholder="http://192.168.1.5:8096" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:border-violet-400 font-mono">
                    </div>
                    <div class="space-y-1.5">
                        <label class="block text-xs font-bold text-slate-500">API Key</label>
                        <input type="password" v-model="form.emby_config.api_key" placeholder="••••••••••••" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:border-violet-400 font-mono">
                    </div>
                </div>
            </div>
        </div>

        <div class="space-y-3 pb-4">
             <div class="flex items-center gap-2 text-slate-600 font-bold text-xs uppercase tracking-wider px-1">
                <i class="fa-solid fa-sliders"></i>
                <h3>高级设置</h3>
            </div>
            <div class="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between shadow-sm">
                <div>
                    <label class="block text-xs font-bold text-slate-700">前端轮询间隔</label>
                    <p class="text-[10px] text-slate-400 mt-0.5">控制任务列表的自动刷新频率</p>
                </div>
                <div class="flex items-center gap-3">
                     <input type="range" v-model="form.frontend_verify_interval" min="1" max="10" step="1" 
                        class="w-24 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600 hover:accent-indigo-500">
                    <span class="text-xs font-mono font-bold text-white bg-indigo-500 px-2 py-0.5 rounded min-w-[3em] text-center shadow-sm">
                        {{ form.frontend_verify_interval }}s
                    </span>
                </div>
            </div>
        </div>

    </div>

    <div class="px-6 py-4 bg-white border-t border-slate-100 flex justify-end shrink-0 z-20 shadow-[0_-4px_20px_rgba(0,0,0,0.02)]">
        <button @click="handleSave" :disabled="isSaving" 
            class="px-8 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white text-sm font-bold rounded-xl shadow-lg shadow-indigo-200 hover:shadow-indigo-300 transition-all active:scale-95 flex items-center gap-2">
            <i v-if="isSaving" class="fa-solid fa-circle-notch fa-spin"></i>
            <span v-else>保存配置</span>
        </button>
    </div>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar { width: 4px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 10px; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #94a3b8; }
</style>