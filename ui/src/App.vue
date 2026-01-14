<script setup>
import { ref } from 'vue'
import ConfigPanel from './components/ConfigPanel.vue'
import LibraryView from './components/LibraryView.vue'
import ImportView from './components/ImportView.vue'
import VerificationView from './components/VerificationView.vue'

const showConfig = ref(false)
const currentTab = ref('library')

const switchTab = (tab) => {
  currentTab.value = tab
}
</script>

<template>
  <div class="min-h-screen bg-slate-50 text-slate-700 font-sans selection:bg-indigo-100 selection:text-indigo-700 pb-safe">
    
    <header class="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-slate-200/60 shadow-sm">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        
        <div class="flex items-center gap-3 group cursor-pointer" @click="currentTab = 'library'">
          <div class="w-9 h-9 bg-gradient-to-br from-indigo-600 to-violet-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-200 group-hover:scale-105 transition-transform duration-300">
             <i class="fa-solid fa-cloud text-white text-lg"></i>
          </div>
          <h1 class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-800 to-slate-600 tracking-tight">
            123<span class="text-indigo-600">Meta</span>Store
          </h1>
        </div>

        <div class="flex items-center gap-3">
          <button @click="showConfig = true" 
            class="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 transition-all active:scale-95">
            <i class="fa-solid fa-gear text-lg"></i>
          </button>
        </div>
      </div>
    </header>

    <Transition name="fade">
      <div v-if="showConfig" class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
        <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" @click="showConfig = false"></div>
        <div class="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
          <ConfigPanel @close="showConfig = false" />
        </div>
      </div>
    </Transition>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 py-6">
      
      <div class="bg-white rounded-2xl shadow-sm border border-slate-200 min-h-[80vh] flex flex-col overflow-hidden">
        
        <div class="flex border-b border-slate-100 px-6 pt-6 gap-6 overflow-x-auto no-scrollbar">
          <button @click="switchTab('library')" 
            class="pb-4 text-sm font-bold relative transition-colors duration-300 flex items-center gap-2"
            :class="currentTab === 'library' ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'">
            <i class="fa-solid fa-film"></i> 媒体库
            <span v-if="currentTab === 'library'" class="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-600 rounded-full shadow-glow"></span>
          </button>
          
          <button @click="switchTab('import')" 
            class="pb-4 text-sm font-bold relative transition-colors duration-300 flex items-center gap-2"
            :class="currentTab === 'import' ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'">
            <i class="fa-solid fa-cloud-arrow-up"></i> 导入资源
            <span v-if="currentTab === 'import'" class="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-600 rounded-full shadow-glow"></span>
          </button>

          <button @click="switchTab('verify')" 
            class="pb-4 text-sm font-bold relative transition-colors duration-300 flex items-center gap-2"
            :class="currentTab === 'verify' ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'">
            <i class="fa-solid fa-list-check"></i> 任务 & 验证
            <span v-if="currentTab === 'verify'" class="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-600 rounded-full shadow-glow"></span>
          </button>
        </div>

        <div class="p-6 flex-1 relative">
          <Transition name="fade-slide" mode="out-in">
            <KeepAlive>
               <component :is="currentTab === 'library' ? LibraryView : currentTab === 'import' ? ImportView : VerificationView" />
            </KeepAlive>
          </Transition>
        </div>
      </div>

      <div class="mt-8 mb-4 text-center flex items-center justify-center gap-2 opacity-40 hover:opacity-100 transition-opacity duration-300">
        <div class="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"></div>
        <p class="text-[10px] text-slate-500 font-mono font-medium tracking-wide">POWERED BY CLOUDFLARE WORKERS</p>
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
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.fade-slide-enter-from {
  opacity: 0;
  transform: translateY(10px);
}
.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

.shadow-glow {
  box-shadow: 0 -2px 10px rgba(79, 70, 229, 0.4);
}
</style>