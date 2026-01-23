<script setup>
import { ref, onMounted, computed, watch, onUnmounted } from 'vue'
import { formatSize } from '../utils/logic.js'
import { dispatchToBackground } from '../utils/dispatcher.js'
import { showToast } from '../utils/toast.js'
import { showConfirm } from '../utils/dialog.js'

// =========================
// 逻辑状态 (保持不变)
// =========================
const fullList = ref([]) 
const totalItems = ref(0) 
const selectedIds = ref(new Set())
const isLoading = ref(false)

// 筛选与分页
const currentFilter = ref('pending') // pending, downloading, failed
const currentPage = ref(1)
const pageSize = ref(parseInt(localStorage.getItem('pending_page_size') || '20'))

// 自动刷新逻辑
let autoRefreshTimer = null
const autoRefreshSeconds = ref(5)

// 计算属性
const totalPages = computed(() => Math.ceil(totalItems.value / pageSize.value))
const isAllSelected = computed(() => {
    return fullList.value.length > 0 && fullList.value.every(item => selectedIds.value.has(item.id))
})

// === 数据获取 ===
const fetchList = async () => {
  isLoading.value = true
  try {
    const res = await fetch(`./api/pending/list?page=${currentPage.value}&size=${pageSize.value}&filter=${currentFilter.value}`)
    const data = await res.json()
    
    if (data.list && typeof data.total !== 'undefined') {
        fullList.value = data.list
        totalItems.value = data.total
        // 翻页或切换筛选后，清理选中态
        selectedIds.value.clear()
    }
  } catch(e) {
    console.error(e)
    showToast("获取任务列表失败", "error")
  } finally {
    isLoading.value = false
  }
}

// === 自动刷新 ===
const startAutoRefresh = () => {
    stopAutoRefresh()
    autoRefreshTimer = setInterval(() => {
        if (autoRefreshSeconds.value <= 1) {
            autoRefreshSeconds.value = 5
            // 只有在非加载状态且不在操作选中项时才刷新，避免打断用户
            if (!isLoading.value && selectedIds.value.size === 0) {
                fetchList()
            }
        } else {
            autoRefreshSeconds.value--
        }
    }, 1000)
}

const stopAutoRefresh = () => {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer)
}

// === 操作逻辑 ===
const changeFilter = (f) => {
    currentFilter.value = f
    currentPage.value = 1
    fetchList()
}

const toggleSelection = (id) => {
    if (selectedIds.value.has(id)) selectedIds.value.delete(id)
    else selectedIds.value.add(id)
}

const toggleSelectAll = () => {
    if (isAllSelected.value) {
        selectedIds.value.clear()
    } else {
        fullList.value.forEach(item => selectedIds.value.add(item.id))
    }
}

const deleteSelected = async () => {
    if (selectedIds.value.size === 0) return

    // 唤起全局确认弹窗
    const result = await showConfirm({
        title: '确定删除?',
        text:  `将移除 ${selectedIds.value.size} 个任务记录`,
        type: 'danger',
        confirmText: '确认删除',
        cancelText: '取消'
    });

    if (!result) return

    try {
        const res = await fetch('./api/pending/delete', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ ids: Array.from(selectedIds.value) })
        })
        const json = await res.json()
        if (json.status === 'ok') {
            showToast(`已删除 ${json.count} 条记录`, "success")
            fetchList()
        }
    } catch(e) {
        showToast("删除失败: " + e.message, "error")
    }
}

const retrySelected = async () => {
    if (selectedIds.value.size === 0) return
    // 提取选中项的完整信息
    const items = fullList.value.filter(i => selectedIds.value.has(i.id))
    const success = await dispatchToBackground(items)
    if (success) {
        // 等待一会刷新
        setTimeout(fetchList, 1000)
    }
}

// 分页
const prevPage = () => { if(currentPage.value > 1) { currentPage.value--; fetchList() } }
const nextPage = () => { if(currentPage.value < totalPages.value) { currentPage.value++; fetchList() } }

// 生命周期
onMounted(() => {
    fetchList()
    startAutoRefresh()
})

onUnmounted(() => {
    stopAutoRefresh()
})

// 监听筛选变化自动重置
watch(currentFilter, () => {
    autoRefreshSeconds.value = 5 // 重置倒计时
})
</script>

<template>
  <div class="h-full flex flex-col relative">
    
    <div class="mb-4 sticky top-0 z-20 -mx-1 px-1 pt-1">
      <div class="bg-white/80 backdrop-blur-xl p-3 rounded-2xl shadow-lg shadow-slate-200/50 border border-white/60 flex flex-wrap justify-between items-center gap-3 transition-all duration-300">
          
          <div class="flex bg-slate-100/80 p-1 rounded-xl border border-slate-200/50">
              <button @click="changeFilter('pending')" 
                class="px-4 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 flex items-center gap-2"
                :class="currentFilter==='pending' ? 'bg-white text-indigo-600 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700'">
                <i class="fa-regular fa-clock"></i> 待处理
              </button>
              <button @click="changeFilter('downloading')" 
                class="px-4 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 flex items-center gap-2"
                :class="currentFilter==='downloading' ? 'bg-white text-blue-600 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700'">
                <i class="fa-solid fa-cloud-arrow-down"></i> 进行中
              </button>
              <button @click="changeFilter('failed')" 
                class="px-4 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 flex items-center gap-2"
                :class="currentFilter==='failed' ? 'bg-white text-red-500 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700'">
                <i class="fa-solid fa-circle-exclamation"></i> 已失败
              </button>
          </div>

          <div class="flex items-center gap-4">
              <div class="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono bg-slate-50 px-2 py-1 rounded border border-slate-100">
                  <i class="fa-solid fa-arrows-rotate" :class="{'fa-spin': isLoading}"></i>
                  <span>{{ isLoading ? '更新中...' : `${autoRefreshSeconds}s` }}</span>
              </div>
              
              <button @click="toggleSelectAll" 
                class="text-xs font-bold px-3 py-1.5 rounded-lg border transition-all active:scale-95 flex items-center gap-2"
                :class="isAllSelected ? 'bg-indigo-50 border-indigo-200 text-indigo-600' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'">
                <i :class="isAllSelected ? 'fa-solid fa-check-square' : 'fa-regular fa-square'"></i> 全选
              </button>
          </div>
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-1 pb-24 relative">
        
        <div v-if="isLoading && fullList.length === 0" class="space-y-3">
            <div v-for="i in 5" :key="i" class="h-20 bg-white/60 rounded-xl animate-pulse"></div>
        </div>

        <div v-else-if="fullList.length === 0" class="flex flex-col items-center justify-center py-20 text-slate-400">
            <div class="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-4 shadow-inner ring-1 ring-slate-100">
                <i class="fa-solid fa-list-check text-3xl opacity-30 text-slate-400"></i>
            </div>
            <p class="text-xs font-bold opacity-60">当前列表为空</p>
        </div>

        <TransitionGroup tag="div" name="list" class="space-y-3">
            <div v-for="item in fullList" :key="item.id" 
                 @click="toggleSelection(item.id)"
                 class="group relative bg-white border border-slate-100 rounded-xl p-3 shadow-sm hover:shadow-md transition-all duration-200 cursor-pointer overflow-hidden"
                 :class="{'ring-2 ring-indigo-500 border-transparent bg-indigo-50/10': selectedIds.has(item.id)}">
                
                <div v-if="currentFilter === 'downloading'" class="absolute bottom-0 left-0 h-1 bg-blue-500/10 w-full">
                     <div class="h-full bg-blue-500/50 animate-progress origin-left w-full"></div>
                </div>

                <div class="flex items-center gap-4 relative z-10">
                    <div class="flex-shrink-0 text-slate-300 transition-colors"
                         :class="{'text-indigo-500': selectedIds.has(item.id), 'group-hover:text-indigo-300': !selectedIds.has(item.id)}">
                        <i class="text-lg" :class="selectedIds.has(item.id) ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle'"></i>
                    </div>

                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 mb-1">
                            <span class="text-xs font-bold text-white px-1.5 py-0.5 rounded-[4px]" 
                                  :class="item.type==='video' ? 'bg-indigo-400' : 'bg-emerald-400'">
                                {{ item.type === 'video' ? '视频' : '字幕' }}
                            </span>
                            <h4 class="text-sm font-bold text-slate-700 truncate" :title="item.cleanName">{{ item.cleanName }}</h4>
                        </div>
                        
                        <div class="flex items-center gap-4 text-[10px] text-slate-400 font-mono">
                            <span class="flex items-center gap-1"><i class="fa-solid fa-database"></i> {{ formatSize(item.size) }}</span>
                            <span v-if="item.tmdbId" class="flex items-center gap-1"><i class="fa-solid fa-film"></i> TMDB:{{ item.tmdbId }}</span>
                            <span v-if="item.season && item.episode" class="bg-slate-100 text-slate-500 px-1 rounded border border-slate-200">S{{ item.season }}E{{ item.episode }}</span>
                        </div>
                    </div>

                    <div class="text-right flex flex-col items-end gap-1">
                         <div class="text-[10px] font-bold px-2 py-0.5 rounded-full border flex items-center gap-1"
                              :class="{
                                  'bg-slate-100 text-slate-500 border-slate-200': currentFilter === 'pending',
                                  'bg-blue-50 text-blue-600 border-blue-100': currentFilter === 'downloading',
                                  'bg-red-50 text-red-500 border-red-100': currentFilter === 'failed'
                              }">
                             <i v-if="currentFilter === 'downloading'" class="fa-solid fa-circle-notch fa-spin"></i>
                             <i v-if="currentFilter === 'failed'" class="fa-solid fa-circle-exclamation"></i>
                             {{ currentFilter === 'pending' ? '等待调度' : (currentFilter === 'downloading' ? '离线中' : `重试: ${item.retryCount}`) }}
                         </div>
                         <span class="text-[9px] text-slate-300 uppercase font-bold tracking-wider">{{ item.sourceType }}</span>
                    </div>
                </div>

                <div v-if="currentFilter === 'failed' && item.retryCount > 0" class="mt-2 text-[10px] text-red-400 bg-red-50/50 px-2 py-1 rounded border border-red-100/50 truncate">
                    <i class="fa-solid fa-triangle-exclamation mr-1"></i> 多次尝试秒传失败，已转入失败队列等待人工处理
                </div>
            </div>
        </TransitionGroup>

        <div v-if="totalPages > 1" class="flex justify-center items-center gap-4 mt-6 mb-8">
            <button @click="prevPage" :disabled="currentPage <= 1" 
                class="w-8 h-8 flex items-center justify-center rounded-full bg-white border border-slate-200 text-slate-400 hover:text-indigo-600 hover:border-indigo-300 shadow-sm disabled:opacity-30 disabled:hover:text-slate-400 transition-all">
                <i class="fa-solid fa-chevron-left text-xs"></i>
            </button>
            <span class="text-xs font-mono font-bold text-slate-400 tracking-widest">{{ currentPage }} / {{ totalPages }}</span>
            <button @click="nextPage" :disabled="currentPage >= totalPages" 
                class="w-8 h-8 flex items-center justify-center rounded-full bg-white border border-slate-200 text-slate-400 hover:text-indigo-600 hover:border-indigo-300 shadow-sm disabled:opacity-30 disabled:hover:text-slate-400 transition-all">
                <i class="fa-solid fa-chevron-right text-xs"></i>
            </button>
        </div>
    </div>

    <Transition name="slide-up">
        <div v-if="selectedIds.size > 0" class="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 bg-slate-800/90 backdrop-blur-md text-white px-2 py-2 rounded-2xl shadow-2xl shadow-slate-900/20 border border-slate-700/50 ring-1 ring-white/10">
            
            <div class="pl-4 pr-2 text-xs font-bold border-r border-slate-600/50 flex items-center gap-2">
                <span class="bg-indigo-500 w-5 h-5 rounded-full flex items-center justify-center text-[10px]">{{ selectedIds.size }}</span>
                <span class="text-slate-300">已选</span>
            </div>

            <button v-if="currentFilter !== 'downloading'" @click="retrySelected" class="px-3 py-1.5 hover:bg-white/10 rounded-lg text-xs font-bold text-emerald-400 transition-colors flex items-center gap-1.5">
                <i class="fa-solid fa-rotate-right"></i> 重试
            </button>

            <button @click="deleteSelected" class="px-3 py-1.5 hover:bg-red-500/20 rounded-lg text-xs font-bold text-red-400 hover:text-red-300 transition-colors flex items-center gap-1.5">
                <i class="fa-regular fa-trash-can"></i> 删除
            </button>

            <button @click="selectedIds.clear()" class="w-7 h-7 flex items-center justify-center hover:bg-white/10 rounded-full text-slate-400 transition-colors ml-1">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    </Transition>

  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar { width: 4px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 10px; }

/* 列表动画 */
.list-enter-active,
.list-leave-active {
  transition: all 0.3s ease;
}
.list-enter-from,
.list-leave-to {
  opacity: 0;
  transform: translateX(20px);
}

/* 底部浮动栏动画 */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translate(-50%, 20px) scale(0.9);
}

@keyframes progress {
    0% { transform: scaleX(0); }
    50% { transform: scaleX(0.7); }
    100% { transform: scaleX(0.95); }
}
.animate-progress {
    animation: progress 20s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
</style>