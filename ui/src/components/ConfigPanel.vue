<template>
  <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex flex-col justify-end sm:justify-center items-center transition-all duration-300" @click.self="$emit('close')">
      
      <div class="bg-white w-full sm:w-[600px] h-[85vh] sm:h-auto sm:max-h-[85vh] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-slide-up sm:animate-scale-in">
        
        <div class="px-8 py-5 border-b border-slate-100 flex items-center justify-between shrink-0 bg-white z-10">
            <div>
                <h2 class="text-lg font-bold text-slate-800">系统设置</h2>
                <p class="text-xs text-slate-400 mt-0.5">配置账号、API 密钥与运行参数</p>
            </div>
            <button @click="$emit('close')" class="w-8 h-8 rounded-full bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 flex items-center justify-center transition-colors">
                <i class="fa-solid fa-times"></i>
            </button>
        </div>

        <div class="flex-1 overflow-y-auto custom-scrollbar p-8 space-y-8">
            
            <div class="space-y-4">
                <div class="flex items-center gap-2 text-indigo-600 font-bold text-sm uppercase tracking-wider">
                    <i class="fa-solid fa-film"></i>
                    <h3>TMDB 元数据</h3>
                </div>
                <div class="bg-slate-50 p-4 rounded-xl border border-slate-100 space-y-3">
                    <label class="block text-xs font-bold text-slate-500 uppercase">API Read Access Token / API Key</label>
                    <input type="text" v-model="form.tmdb_key" placeholder="输入 TMDB API Key" 
                        class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-50 transition-all font-mono">
                    <p class="text-[10px] text-slate-400">用于搜索剧集信息、获取海报与演职人员数据。</p>
                </div>
            </div>

            <div class="space-y-4">
                <div class="flex items-center gap-2 text-blue-600 font-bold text-sm uppercase tracking-wider">
                    <i class="fa-solid fa-cloud"></i>
                    <h3>123 网盘配置 (核心)</h3>
                </div>
                <div class="bg-blue-50/50 p-4 rounded-xl border border-blue-100 space-y-4">
                    
                    <div class="grid grid-cols-2 gap-4">
                        <div class="space-y-1">
                            <label class="block text-xs font-bold text-slate-500">ClientID (VIP)</label>
                            <input type="text" v-model="form.vip_id" placeholder="123盘 开放平台 ClientID" 
                                class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-50 outline-none font-mono">
                        </div>
                        <div class="space-y-1">
                            <label class="block text-xs font-bold text-slate-500">ClientSecret (VIP)</label>
                            <input type="password" v-model="form.vip_secret" placeholder="••••••••••••" 
                                class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-50 outline-none font-mono">
                        </div>
                    </div>

                    <div class="space-y-1">
                        <label class="block text-xs font-bold text-slate-500 flex items-center gap-1">
                            工兵账号池 (Workers) 
                            <span class="px-1.5 py-0.5 rounded bg-orange-100 text-orange-600 text-[9px]">推荐配置</span>
                        </label>
                        <textarea v-model="form.worker_accounts" rows="3" placeholder="ID:Secret,ID:Secret (多个账号用英文逗号分隔)" 
                            class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-50 outline-none font-mono custom-scrollbar"></textarea>
                        <label class="text-[10px] text-slate-400 leading-relaxed">
                            工兵账号用于高频探测文件秒传状态，保护 VIP 账号不被风控。建议配置 1-3 个免费账号。
                        </label>
                    </div>

                    <div class="grid grid-cols-2 gap-4">
                         <div class="space-y-1">
                            <label class="block text-xs font-bold text-slate-500">目标存储目录 ID</label>
                            <input type="text" v-model="form.open123_dir_id" placeholder="0 (根目录)" 
                                class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-50 outline-none font-mono">
                        </div>
                         <div class="space-y-1">
                            <label class="block text-xs font-bold text-slate-500">后端缓存根目录 ID</label>
                            <input type="text" v-model="form.root_folder_id" placeholder="0 (自动管理)" 
                                class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:border-blue-400 focus:ring-2 focus:ring-blue-50 outline-none font-mono">
                        </div>
                    </div>
                </div>
            </div>

            <div class="space-y-4">
                <div class="flex items-center gap-2 text-green-600 font-bold text-sm uppercase tracking-wider">
                    <i class="fa-solid fa-cookie-bite"></i>
                    <h3>夸克 Cookie</h3>
                </div>
                <div class="bg-green-50/50 p-4 rounded-xl border border-green-100 space-y-3">
                    <label class="block text-xs font-bold text-slate-500">Cookie (包含 _csrf_token 等)</label>
                    <textarea v-model="form.quark_cookie" rows="2" placeholder="输入夸克网页版 Cookie" 
                        class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-green-400 focus:ring-2 focus:ring-green-50 font-mono custom-scrollbar"></textarea>
                    <p class="text-[10px] text-slate-400">仅用于解析夸克分享链接，不会保存到本地浏览器，直接加密存储于服务器数据库。</p>
                </div>
            </div>

            <div class="space-y-4">
                <div class="flex items-center gap-2 text-slate-600 font-bold text-sm uppercase tracking-wider">
                    <i class="fa-solid fa-sliders"></i>
                    <h3>高级设置</h3>
                </div>
                <div class="bg-slate-50 p-4 rounded-xl border border-slate-100 flex items-center justify-between">
                    <div>
                        <label class="block text-xs font-bold text-slate-600">任务轮询间隔</label>
                        <p class="text-[10px] text-slate-400 mt-0.5">控制任务队列的前端刷新频率</p>
                    </div>
                    <div class="flex items-center gap-3">
                         <input type="range" v-model="form.frontend_verify_interval" min="1" max="10" step="1" 
                            class="w-24 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600 hover:accent-indigo-500">
                        <span class="text-xs font-mono font-bold text-white bg-indigo-500 px-2 py-0.5 rounded min-w-[3em] text-center">
                            {{ form.frontend_verify_interval }}s
                        </span>
                    </div>
                </div>
            </div>

        </div>

        <div class="px-8 py-5 bg-white border-t border-slate-100 flex justify-end shadow-[0_-5px_20px_rgba(0,0,0,0.02)] shrink-0 z-20">
            <button @click="handleSave" :disabled="isSaving" 
                class="px-8 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white text-sm font-bold rounded-xl shadow-lg shadow-indigo-200 hover:shadow-indigo-300 transition-all active:scale-95 flex items-center gap-2">
                <i v-if="isSaving" class="fa-solid fa-circle-notch fa-spin"></i>
                <i v-else class="fa-solid fa-check"></i> 
                {{ isSaving ? '保存中...' : '保存配置' }}
            </button>
        </div>
      </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import Toastify from 'toastify-js'
// [关键] 引入全局状态管理
import { globalConfig, initConfig } from '../utils/configStore.js'

const emit = defineEmits(['close'])
const isSaving = ref(false)

// 本地表单状态 (与 globalConfig 解耦，避免未保存直接修改全局状态)
const form = ref({
    tmdb_key: '',
    quark_cookie: '',
    vip_id: '',
    vip_secret: '',
    worker_accounts: '',
    open123_dir_id: '',
    root_folder_id: '',
    frontend_verify_interval: 3
})

// 初始化：从全局状态复制到表单
onMounted(() => {
    // 如果全局配置还没加载完，可能为空，但 initConfig 会在 App 启动时调用
    // 这里做个简单的深拷贝
    form.value.tmdb_key = globalConfig.tmdbKey || ''
    form.value.quark_cookie = globalConfig.quarkCookie || ''
    form.value.vip_id = globalConfig.vipId || ''
    form.value.vip_secret = globalConfig.vipSecret || ''
    form.value.worker_accounts = globalConfig.workerAccounts || ''
    form.value.open123_dir_id = globalConfig.open123DirId || ''
    form.value.root_folder_id = globalConfig.rootFolderId || ''
    // 这个字段暂时不在 globalConfig 里（因为只影响前端 UI），可以考虑存在 localStorage 或者也存 DB
    // 为了架构统一，这里假设后端也会存，或者 fallback 到 localStorage
    form.value.frontend_verify_interval = parseInt(localStorage.getItem('frontend_verify_interval') || '3')

    document.body.style.overflow = 'hidden'
})

onUnmounted(() => {
    document.body.style.overflow = ''
})

const handleSave = async () => {
    isSaving.value = true
    try {
        // 1. 保存 UI 偏好到本地 (非敏感数据)
        localStorage.setItem('frontend_verify_interval', form.value.frontend_verify_interval)

        // 2. 组装后端配置 Payload
        // 注意：Keys 必须与后端 app.js 接收的 keys 以及 schema.prisma 中的 keys 一致
        const apiPayload = {
            configs: {
                tmdb_key: form.value.tmdb_key,
                quark_cookie: form.value.quark_cookie,
                vip_id: form.value.vip_id,
                vip_secret: form.value.vip_secret,
                worker_accounts: form.value.worker_accounts,
                open123_dir_id: form.value.open123_dir_id,
                root_folder_id: form.value.root_folder_id
            }
        }

        // 3. 发送给后端
        const res = await fetch('./api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(apiPayload)
        })
        
        const json = await res.json()
        if (!json.success) throw new Error(json.message)

        // 4. [关键] 成功后刷新前端全局状态
        await initConfig()

        Toastify({
            text: "✅ 配置已保存并热重载生效",
            duration: 3000,
            style: { background: "#10b981" }
        }).showToast()
        
        emit('close')

    } catch (e) {
        console.error(e)
        Toastify({
            text: "❌ 保存失败: " + e.message,
            duration: 4000,
            style: { background: "#ef4444" }
        }).showToast()
    } finally {
        isSaving.value = false
    }
}
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
    width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
    background-color: #e2e8f0;
    border-radius: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: #cbd5e1;
}

@keyframes slide-up {
    from { transform: translateY(100%); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
}
@keyframes scale-in {
    from { transform: scale(0.95); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
}
.animate-slide-up { animation: slide-up 0.3s ease-out; }
.animate-scale-in { animation: scale-in 0.2s ease-out; }
</style>