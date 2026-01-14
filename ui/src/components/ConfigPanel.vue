<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import Toastify from 'toastify-js'

const tmdbKey = ref('')
const quarkCookie = ref('')
const Accesstoken = ref('')
const open123Id = ref('')
const open123Secret = ref('')
const open123DirId = ref('')
const verifyInterval = ref(3) 

const emit = defineEmits(['close'])

onMounted(() => {
  tmdbKey.value = localStorage.getItem('tmdb_key') || ''
  quarkCookie.value = localStorage.getItem('quark_cookie') || ''
  Accesstoken.value = localStorage.getItem('ty_accesstoken') || ''
  open123Id.value = localStorage.getItem('open123_id') || ''
  open123Secret.value = localStorage.getItem('open123_secret') || ''
  open123DirId.value = localStorage.getItem('open123_dir_id') || ''
  verifyInterval.value = parseInt(localStorage.getItem('verify_interval') || '3')

  // [JS层保险] 打开设置时，禁止背景页面滚动
  document.body.style.overflow = 'hidden'
})

// 组件销毁时恢复背景滚动
onUnmounted(() => {
  document.body.style.overflow = ''
})

const saveConfig = () => {
  localStorage.setItem('tmdb_key', tmdbKey.value)
  localStorage.setItem('quark_cookie', quarkCookie.value)
  localStorage.setItem('ty_accesstoken', Accesstoken.value)
  localStorage.setItem('open123_id', open123Id.value)
  localStorage.setItem('open123_secret', open123Secret.value)
  localStorage.setItem('open123_dir_id', open123DirId.value)
  localStorage.setItem('verify_interval', verifyInterval.value)
  
  window.dispatchEvent(new Event('config-update'))

  Toastify({
    text: "配置已保存",
    duration: 2000,
    gravity: "top", 
    position: "center",
    style: { background: "#10b981", borderRadius: "8px", boxShadow: "0 4px 12px rgba(16, 185, 129, 0.3)" }
  }).showToast();
  
  emit('close')
}
</script>

<template>
  <div class="flex flex-col h-full bg-slate-50/50 overflow-hidden" @click.stop>
      
      <div class="px-8 py-6 border-b border-slate-200/60 bg-white/80 backdrop-blur-md flex justify-between items-center shrink-0 z-20">
        <h2 class="text-xl font-bold text-slate-800 flex items-center gap-3">
            <div class="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-lg shadow-indigo-200">
                <i class="fa-solid fa-sliders"></i>
            </div>
            系统设置
        </h2>
        <button @click="$emit('close')" class="w-9 h-9 flex items-center justify-center rounded-full bg-slate-100 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-all active:scale-90">
            <i class="fa-solid fa-times"></i>
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto p-8 custom-scrollbar overscroll-contain">
        <div class="space-y-10 max-w-3xl mx-auto">
            
            <div class="space-y-4">
                <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 mb-4">
                    <span class="w-2 h-2 rounded-full bg-indigo-500 ring-4 ring-indigo-100"></span> 刮削源配置
                </h4>
                <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                    <div class="space-y-2">
                        <label class="text-xs font-bold text-slate-600 ml-1">TMDB API Key</label>
                        <div class="relative">
                            <i class="fa-solid fa-key absolute left-4 top-3.5 text-slate-300"></i>
                            <input type="text" v-model="tmdbKey" @change="saveConfig" placeholder="输入 TMDB Read Access Token..." class="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm transition-all font-mono">
                        </div>
                        <p class="text-[10px] text-slate-400 ml-1">用于获取电影/剧集的元数据信息。</p>
                    </div>
                </div>
            </div>

            <div class="space-y-4">
                <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 mb-4">
                    <span class="w-2 h-2 rounded-full bg-emerald-500 ring-4 ring-emerald-100"></span> 123云盘配置 (目标盘)
                </h4>
                <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow space-y-5">
                    <div class="grid grid-cols-2 gap-5">
                        <div class="space-y-2">
                            <label class="text-xs font-bold text-slate-600 ml-1">ClientID</label>
                            <input type="text" v-model="open123Id" @change="saveConfig" class="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm transition-all font-mono">
                        </div>
                        <div class="space-y-2">
                            <label class="text-xs font-bold text-slate-600 ml-1">ClientSecret</label>
                            <input type="password" v-model="open123Secret" @change="saveConfig" class="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm transition-all font-mono">
                        </div>
                    </div>
                    <div class="space-y-2">
                        <label class="text-xs font-bold text-slate-600 ml-1">目标文件夹 ID</label>
                        <div class="flex gap-2">
                             <input type="text" v-model="open123DirId" @change="saveConfig" placeholder="默认根目录" class="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm transition-all font-mono">
                             <div class="px-4 py-3 bg-slate-100 rounded-xl text-xs text-slate-500 flex items-center font-mono border border-slate-200">
                                 dirID
                             </div>
                        </div>
                        <p class="text-[10px] text-slate-400 ml-1">文件将被保存到该文件夹下。</p>
                    </div>
                </div>
            </div>

            <div class="space-y-4">
                <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 mb-4">
                    <span class="w-2 h-2 rounded-full bg-orange-400 ring-4 ring-orange-100"></span> 第三方账号授权
                </h4>
                <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow space-y-5">
                    <div class="space-y-2">
                        <label class="text-xs font-bold text-slate-600 ml-1">夸克网盘 Cookie</label>
                        <div class="relative">
                             <i class="fa-solid fa-cookie-bite absolute left-4 top-3.5 text-slate-300"></i>
                             <input type="text" v-model="quarkCookie" @change="saveConfig" placeholder="输入夸克 Cookie..." class="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm transition-all font-mono">
                        </div>
                    </div>
                    <div class="space-y-2">
                        <label class="text-xs font-bold text-slate-600 ml-1">天翼云 AccessToken</label>
                        <div class="relative">
                            <i class="fa-solid fa-ticket absolute left-4 top-3.5 text-slate-300"></i>
                            <input type="text" v-model="Accesstoken" @change="saveConfig" placeholder="输入天翼云 Token..." class="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm transition-all font-mono">
                        </div>
                    </div>
                </div>
            </div>

             <div class="bg-indigo-50/50 p-6 rounded-2xl border border-indigo-100/50 space-y-4">
                <div class="flex items-center justify-between">
                    <label class="text-xs font-bold text-indigo-900">后台任务轮询间隔</label>
                    <span class="text-xs font-mono font-bold text-white bg-indigo-500 px-2 py-0.5 rounded">{{ verifyInterval }} 秒</span>
                </div>
                <input type="range" v-model="verifyInterval" min="1" max="10" step="1" @change="saveConfig" 
                    class="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600 hover:accent-indigo-500">
                <p class="text-[10px] text-indigo-400">控制任务队列的处理频率，建议保持在 3-5秒。</p>
            </div>

        </div>
      </div>

      <div class="px-8 py-5 bg-white border-t border-slate-100 flex justify-end shadow-[0_-5px_20px_rgba(0,0,0,0.02)] shrink-0 z-20">
        <button @click="saveConfig" class="px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl shadow-lg shadow-indigo-200 hover:shadow-indigo-300 transition-all active:scale-95 flex items-center gap-2">
            <i class="fa-solid fa-check"></i> 保存配置
        </button>
      </div>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
    width: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
    background-color: rgba(148, 163, 184, 0.3);
    border-radius: 20px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: rgba(148, 163, 184, 0.5);
}
/* 核心：阻止滚动事件冒泡到父层 */
.overscroll-contain {
    overscroll-behavior: contain;
}
</style>