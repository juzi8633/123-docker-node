<script setup>
import { ref, onMounted, computed } from 'vue'
import ConfigPanel from './components/ConfigPanel.vue'
import LibraryView from './components/LibraryView.vue'
import ImportView from './components/ImportView.vue'
import VerificationView from './components/VerificationView.vue'
// [新增] 引入全局弹窗组件
import GlobalConfirm from './components/GlobalConfirm.vue'

import GlobalToast from './components/GlobalToast.vue'

import { initConfig, globalConfig } from './utils/configStore.js'

const showConfig = ref(false)
const currentTab = ref('library')

const configLoaded = computed(() => globalConfig.isLoaded)

const switchTab = (tab) => {
  currentTab.value = tab
}

onMounted(async () => {
    await initConfig()
})
</script>

<template>
  <div class="min-h-screen bg-[#f8fafc] text-slate-700 font-sans selection:bg-indigo-500/30 selection:text-indigo-800 pb-safe relative overflow-x-hidden">
    
    <GlobalConfirm />
    <GlobalToast />

    <div class="fixed top-0 left-0 w-full h-96 bg-gradient-to-b from-indigo-50/50 to-transparent pointer-events-none z-0"></div>

    <header class="sticky top-0 z-50 bg-white/70 backdrop-blur-xl border-b border-slate-200/50 shadow-sm transition-all duration-300">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between relative z-10">
        
        <div class="flex items-center gap-3 group cursor-pointer select-none" @click="currentTab = 'library'">
          <div class="w-9 h-9 bg-gradient-to-br from-indigo-600 to-violet-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/30 group-hover:scale-105 group-hover:rotate-3 transition-all duration-300">
             <i class="fa-solid fa-cloud text-white text-lg drop-shadow-sm"></i>
          </div>
          <h1 class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-800 to-slate-600 tracking-tight group-hover:from-indigo-600 group-hover:to-violet-600 transition-all duration-300">
            123<span class="text-indigo-600">Meta</span>Store
          </h1>
        </div>

        <div class="flex items-center gap-3">
          <Transition name="fade">
            <div v-if="!configLoaded" class="hidden sm:flex items-center gap-2 px-3 py-1 bg-amber-50/80 backdrop-blur text-amber-600 border border-amber-200/50 rounded-full text-xs font-bold animate-pulse shadow-sm">
                <i class="fa-solid fa-circle-notch fa-spin"></i> 
                <span>连接后端...</span>
            </div>
          </Transition>

          <button @click="showConfig = true" 
            class="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:text-indigo-600 hover:bg-indigo-50/80 border border-transparent hover:border-indigo-100 transition-all active:scale-95 group"
            title="系统设置">
            <i class="fa-solid fa-gear text-lg group-hover:rotate-90 transition-transform duration-500"></i>
          </button>
        </div>
      </div>
    </header>

    <Transition name="fade">
      <div v-if="showConfig" class="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
        <div class="absolute inset-0 bg-slate-900/30 backdrop-blur-sm transition-opacity" @click="showConfig = false"></div>
        <div class="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl shadow-slate-900/20 overflow-hidden flex flex-col max-h-[90vh] ring-1 ring-black/5">
          <ConfigPanel @close="showConfig = false" />
        </div>
      </div>
    </Transition>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 py-6 relative z-10">
      
      <div class="bg-white/80 backdrop-blur-md rounded-2xl shadow-xl shadow-slate-200/50 border border-white/60 min-h-[80vh] flex flex-col overflow-hidden ring-1 ring-slate-900/5">
        
        <div class="flex-shrink-0 border-b border-slate-100 px-6 pt-6 pb-4">
          <div class="flex p-1 bg-slate-100/60 rounded-xl gap-1 overflow-x-auto no-scrollbar max-w-full sm:max-w-fit border border-slate-200/50">
            
            <button @click="switchTab('library')" 
              class="relative px-5 py-2.5 rounded-lg text-sm font-bold transition-all duration-200 flex items-center gap-2 flex-shrink-0 select-none outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              :class="currentTab === 'library' 
                ? 'bg-white text-indigo-600 shadow-sm ring-1 ring-black/5 scale-[1.02]' 
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'">
              <i class="fa-solid fa-film" :class="{'animate-bounce-subtle': currentTab === 'library'}"></i> 媒体库
            </button>
            
            <button @click="switchTab('import')" 
              class="relative px-5 py-2.5 rounded-lg text-sm font-bold transition-all duration-200 flex items-center gap-2 flex-shrink-0 select-none outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              :class="currentTab === 'import' 
                ? 'bg-white text-indigo-600 shadow-sm ring-1 ring-black/5 scale-[1.02]' 
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'">
              <i class="fa-solid fa-cloud-arrow-up" :class="{'animate-bounce-subtle': currentTab === 'import'}"></i> 导入资源
            </button>

            <button @click="switchTab('verify')" 
              class="relative px-5 py-2.5 rounded-lg text-sm font-bold transition-all duration-200 flex items-center gap-2 flex-shrink-0 select-none outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              :class="currentTab === 'verify' 
                ? 'bg-white text-indigo-600 shadow-sm ring-1 ring-black/5 scale-[1.02]' 
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'">
              <i class="fa-solid fa-list-check" :class="{'animate-bounce-subtle': currentTab === 'verify'}"></i> 任务 & 验证
            </button>

          </div>
        </div>

        <div class="p-6 flex-1 relative min-h-0 overflow-hidden flex flex-col">
          <Transition name="fade-slide" mode="out-in">
            <KeepAlive>
               <component :is="currentTab === 'library' ? LibraryView : currentTab === 'import' ? ImportView : VerificationView" />
            </KeepAlive>
          </Transition>
        </div>
      </div>

      <div class="mt-8 mb-4 text-center flex items-center justify-center gap-2 opacity-60 hover:opacity-100 transition-opacity duration-300 cursor-default">
        <div class="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)] animate-pulse"></div>
        <p class="text-[10px] text-slate-400 font-mono font-medium tracking-wide">POWERED BY CLOUDFLARE WORKERS</p>
      </div>

    </main>
  </div>
</template>

<style scoped>
.pb-safe {
  padding-bottom: env(safe-area-inset-bottom);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}
.fade-slide-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.99);
}
.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.99);
}

@keyframes bounce-subtle {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-10%); }
}
.animate-bounce-subtle {
  animation: bounce-subtle 0.3s ease-out;
}
</style>