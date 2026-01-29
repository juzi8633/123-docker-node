<script setup>
import { ref } from 'vue'
import { showToast } from '../utils/toast.js'

const emit = defineEmits(['login-success'])
const password = ref('')
const isLoading = ref(false)

const handleLogin = async () => {
  const val = password.value.trim()
  if (!val) {
    showToast('请输入访问密码', 'warning')
    return
  }
  
  isLoading.value = true
  try {
    // 主动尝试请求一个受保护的 API (获取配置) 来验证密码有效性
    // 这里显式添加 Header，不依赖全局拦截器，避免死循环
    const res = await fetch('./api/config', {
      headers: { 'Authorization': val }
    })

    if (res.status === 200) {
      // 验证成功：写入持久化存储
      localStorage.setItem('secret', val)
      showToast('验证通过，欢迎回来', 'success')
      emit('login-success')
    } else if (res.status === 401) {
      showToast('密码错误，鉴权失败', 'error')
    } else {
      showToast(`服务器响应异常 (${res.status})`, 'error')
    }
  } catch (e) {
    console.error(e)
    showToast('网络请求失败，请检查连接', 'error')
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <div class="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-50/80 backdrop-blur-sm">
    <div class="w-full max-w-sm bg-white/90 backdrop-blur-xl border border-white/60 rounded-2xl shadow-2xl p-8 animate-in fade-in zoom-in duration-300 ring-1 ring-slate-900/5">
      
      <div class="text-center mb-8">
        <div class="w-16 h-16 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl mx-auto flex items-center justify-center shadow-lg shadow-indigo-500/30 mb-4 transform transition-transform hover:scale-105 duration-500">
          <i class="fa-solid fa-shield-halved text-white text-3xl drop-shadow-sm"></i>
        </div>
        <h2 class="text-2xl font-extrabold text-slate-800 tracking-tight">123MetaStore</h2>
        <p class="text-xs font-medium text-slate-400 mt-2 uppercase tracking-widest">System Locked</p>
      </div>

      <div class="space-y-5">
        <div class="relative group">
          <input 
            type="password" 
            v-model="password" 
            @keyup.enter="handleLogin"
            :disabled="isLoading"
            class="w-full pl-11 pr-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all text-sm font-medium text-slate-700 placeholder:text-slate-400 disabled:opacity-50 disabled:cursor-not-allowed group-hover:border-indigo-200"
            placeholder="请输入访问密码..."
            autofocus
          >
          <i class="fa-solid fa-key absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors duration-300"></i>
        </div>

        <button 
          @click="handleLogin" 
          :disabled="isLoading"
          class="w-full py-3.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white rounded-xl font-bold text-sm shadow-lg shadow-indigo-200 hover:shadow-indigo-300 hover:-translate-y-0.5 transition-all active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none flex items-center justify-center gap-2"
        >
          <i v-if="isLoading" class="fa-solid fa-circle-notch fa-spin"></i>
          <span v-else>解锁系统</span>
          <i v-if="!isLoading" class="fa-solid fa-arrow-right opacity-60"></i>
        </button>
      </div>
    </div>
  </div>
</template>