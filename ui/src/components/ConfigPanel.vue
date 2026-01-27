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
    cloud189_token: '', 
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
    form.value.cloud189_token = globalConfig.cloud189Token || ''

    if (globalConfig.embyConfig) {
        form.value.emby_config = { ...globalConfig.embyConfig }
    }
    form.value.frontend_verify_interval = parseInt(localStorage.getItem('pending_refresh_interval') || '3')
})

const handleSave = async () => {
    isSaving.value = true
    try {
        const payload = {
            configs: {
                tmdb_key: form.value.tmdb_key,
                quark_cookie: form.value.quark_cookie,
                vip_id: form.value.vip_id,
                vip_secret: form.value.vip_secret,
                worker_accounts: form.value.worker_accounts,
                open123_dir_id: form.value.open123_dir_id,
                root_folder_id: form.value.root_folder_id,
                cloud189_token: form.value.cloud189_token,
            }
        }
        const res = await fetch('./api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        if (!res.ok) throw new Error('保存失败')
        await initConfig()
        showToast('配置已保存并热重载', 'success')
        emit('close')
    } catch (e) {
        showToast(e.message, 'error')
    } finally {
        isSaving.value = false
    }
}

</script>

<template>
  <div class="fixed inset-0 z-[150] flex items-center justify-end">
    <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" @click="emit('close')"></div>
    <div class="relative w-full max-w-lg h-full bg-slate-50 shadow-2xl flex flex-col animate-slide-in-right">
        
        <div class="px-6 py-5 bg-white border-b border-slate-100 flex items-center justify-between shrink-0">
            <div>
                <h3 class="text-lg font-bold text-slate-800">系统配置</h3>
                <p class="text-xs text-slate-400 mt-0.5">管理核心凭证与同步维护</p>
            </div>
            <button @click="emit('close')" class="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-slate-100 text-slate-400 transition-colors">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>

        <div class="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-8">

            <div class="space-y-4">
                <div class="flex items-center gap-2 px-1">
                    <i class="fa-solid fa-key text-indigo-500"></i>
                    <span class="text-sm font-bold text-slate-700">基础凭证</span>
                </div>
                <div class="space-y-3">
                    <div class="group">
                        <label class="block text-[11px] font-bold text-slate-400 ml-1 mb-1 uppercase tracking-wider">TMDB API Key</label>
                        <input type="password" v-model="form.tmdb_key" placeholder="填写 TMDB 密钥" class="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm shadow-sm group-hover:shadow-md">
                    </div>
                    <div class="group">
                        <label class="block text-[11px] font-bold text-slate-400 ml-1 mb-1 uppercase tracking-wider">189 Cloud Token</label>
                        <input type="password" v-model="form.cloud189_token" placeholder="天翼云 AccessToken" class="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm shadow-sm group-hover:shadow-md">
                    </div>
                    <div class="group">
                        <label class="block text-[11px] font-bold text-slate-400 ml-1 mb-1 uppercase tracking-wider">Quark Cookie</label>
                        <textarea v-model="form.quark_cookie" rows="3" placeholder="填写夸克网盘 Cookie" class="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm shadow-sm group-hover:shadow-md resize-none custom-scrollbar"></textarea>
                    </div>
                </div>
            </div>

            <div class="space-y-4">
                <div class="flex items-center gap-2 px-1">
                    <i class="fa-solid fa-server text-indigo-500"></i>
                    <span class="text-sm font-bold text-slate-700">123网盘 (开放平台)</span>
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div class="group">
                        <label class="block text-[11px] font-bold text-slate-400 ml-1 mb-1 uppercase tracking-wider">Client ID</label>
                        <input v-model="form.vip_id" class="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm shadow-sm">
                    </div>
                    <div class="group">
                        <label class="block text-[11px] font-bold text-slate-400 ml-1 mb-1 uppercase tracking-wider">Client Secret</label>
                        <input type="password" v-model="form.vip_secret" class="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm shadow-sm">
                    </div>
                </div>
                <div class="space-y-1.5">
                    <label class="block text-[11px] font-bold text-slate-400 ml-1 mb-1 uppercase tracking-wider">工兵账号池 (Workers)</label>
                    <textarea v-model="form.worker_accounts" rows="3" placeholder="ID:Secret,ID:Secret" class="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm shadow-sm group-hover:shadow-md resize-none custom-scrollbar"></textarea>
                </div>
                 <div class="grid grid-cols-2 gap-4">
                     <div class="space-y-1.5">
                        <label class="block text-[11px] font-bold text-slate-400 ml-1 mb-1 uppercase tracking-wider">目标存储目录 ID</label>
                        <input type="text" v-model="form.open123_dir_id" placeholder="0" class="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm shadow-sm">
                    </div>
                     <div class="space-y-1.5">
                        <label class="block text-[11px] font-bold text-slate-400 ml-1 mb-1 uppercase tracking-wider">后端缓存根目录 ID</label>
                        <input type="text" v-model="form.root_folder_id" placeholder="0" class="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm shadow-sm">
                    </div>
                </div>
            </div>

            <div class="space-y-4 pb-4">
                <div class="flex items-center gap-2 px-1">
                    <i class="fa-solid fa-gauge-high text-indigo-500"></i>
                    <span class="text-sm font-bold text-slate-700">交互偏好</span>
                </div>
                <div class="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center justify-between">
                    <div>
                        <div class="text-xs font-bold text-slate-600">刷新间隔 (秒传队列)</div>
                        <div class="text-[10px] text-slate-400">降低频率可减轻浏览器负担</div>
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
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar { width: 4px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 10px; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #94a3b8; }

.animate-slide-in-right {
    animation: slideInRight 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideInRight {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
}
</style>