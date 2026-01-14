<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { formatSize } from '../utils/logic.js'
// [核心修改] 引入后台调度器，替代原有的前端验证脚本
import { dispatchToBackground } from '../utils/dispatcher.js'
import Toastify from 'toastify-js'

// === 状态定义 ===
const fullList = ref([]) 
const totalItems = ref(0) 
const selectedIds = ref(new Set())
const isLoading = ref(false)

// 筛选与分页
const currentFilter = ref('pending') // pending, downloading, failed
const currentPage = ref(1)
const pageSize = ref(parseInt(localStorage.getItem('pending_page_size') || '20'))

// 计算属性
const totalPages = computed(() => Math.ceil(totalItems.value / pageSize.value))
const isAllSelected = computed(() => {
    return fullList.value.length > 0 && fullList.value.every(item => selectedIds.value.has(item.id))
})

// === 数据获取 ===
const fetchList = async () => {
  isLoading.value = true
  try {
    // 调用后端 API 获取列表
    const res = await fetch(`./api/pending/list?page=${currentPage.value}&size=${pageSize.value}&filter=${currentFilter.value}`)
    const data = await res.json()
    
    if (data.list && typeof data.total !== 'undefined') {
        fullList.value = data.list
        totalItems.value = data.total
        // 翻页后清空选中，防止操作错误
        selectedIds.value.clear()
    }
  } catch (e) {
    console.error("Fetch list error:", e)
    Toastify({ text: "获取列表失败", style: { background: "#ef4444" } }).showToast()
  } finally {
    isLoading.value = false
  }
}

// === 核心操作：提交到后台处理 ===
const startProcess = async () => {
  if (selectedIds.value.size === 0) return
  
  // 1. 获取选中的文件对象
  const selectedFiles = fullList.value.filter(item => selectedIds.value.has(item.id))
  
  if (selectedFiles.length === 0) return

  isLoading.value = true // 暂时显示加载状态，防止重复点击
  
  try {
      // 2. 调用调度器发送给 DO 后台
      const success = await dispatchToBackground(selectedFiles)
      
      if (success) {
          // 3. 成功后逻辑
          // 清空选中状态
          selectedIds.value.clear()
          
          // 延迟刷新列表，让用户看到状态变化（虽然 DO 是异步的，但 UI 响应要快）
          setTimeout(() => fetchList(), 1000)
      }
  } catch (e) {
      console.error(e)
  } finally {
      isLoading.value = false
  }
}

// === [修改] 批量删除 - 使用 Swal ===
const deleteSelected = async () => {
    if (selectedIds.value.size === 0) return
    
    const result = await Swal.fire({
        title: '确认删除?',
        text: `确定要删除选中的 ${selectedIds.value.size} 个任务吗？`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#cbd5e1',
        confirmButtonText: '删除',
        cancelButtonText: '取消'
    });

    if (!result.isConfirmed) return;

    try {
        const res = await fetch('./api/pending/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: Array.from(selectedIds.value) })
        })
        const data = await res.json()
        if (data.status === 'ok') {
            Toastify({ 
                text: `已删除 ${data.count} 个任务`, 
                style: { background: "#10b981" } 
            }).showToast()
            selectedIds.value.clear()
            fetchList()
        } else {
            throw new Error(data.message)
        }
    } catch (e) {
        Toastify({ text: `删除失败: ${e.message}`, style: { background: "#ef4444" } }).showToast()
    }
}

// === 交互逻辑 ===
const toggleSelectAll = () => {
    if (isAllSelected.value) {
        selectedIds.value.clear()
    } else {
        fullList.value.forEach(item => selectedIds.value.add(item.id))
    }
}

const toggleSelect = (id) => {
    if (selectedIds.value.has(id)) {
        selectedIds.value.delete(id)
    } else {
        selectedIds.value.add(id)
    }
}

const changeFilter = (filter) => {
    currentFilter.value = filter
    currentPage.value = 1
    fetchList()
}

const prevPage = () => {
    if (currentPage.value > 1) {
        currentPage.value--
        fetchList()
    }
}

const nextPage = () => {
    if (currentPage.value < totalPages.value) {
        currentPage.value++
        fetchList()
    }
}

const changePageSize = () => {
    localStorage.setItem('pending_page_size', pageSize.value)
    currentPage.value = 1
    fetchList()
}

// 监听
watch(currentPage, fetchList)

onMounted(() => {
    fetchList()
})
</script>

<template>
  <div class="h-full flex flex-col bg-slate-50/80 rounded-3xl border border-white/60 shadow-xl backdrop-blur-xl overflow-hidden relative">
    
    <div class="px-6 py-5 border-b border-slate-200/60 flex flex-wrap items-center justify-between gap-4 bg-white/60 z-10">
        <div class="flex items-center gap-6">
            <h2 class="text-xl font-bold text-slate-800 flex items-center gap-3 tracking-tight">
                <div class="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shadow-sm">
                    <i class="fa-solid fa-list-check text-lg"></i>
                </div>
                任务队列
            </h2>
            
            <div class="flex bg-slate-200/60 p-1 rounded-xl shadow-inner gap-1">
                <button @click="changeFilter('pending')" 
                    class="px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 ease-out"
                    :class="currentFilter === 'pending' ? 'bg-white text-indigo-600 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'">
                    待处理
                </button>
                <button @click="changeFilter('downloading')" 
                    class="px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 ease-out"
                    :class="currentFilter === 'downloading' ? 'bg-white text-blue-600 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'">
                    下载中
                </button>
                <button @click="changeFilter('failed')" 
                    class="px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 ease-out"
                    :class="currentFilter === 'failed' ? 'bg-white text-red-600 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'">
                    需重试
                </button>
            </div>
        </div>

        <div class="flex items-center gap-3">
            <button @click="fetchList" 
                class="w-9 h-9 rounded-full bg-white border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all duration-300 flex items-center justify-center shadow-sm active:scale-90"
                title="刷新列表">
                <i class="fa-solid fa-rotate-right" :class="{'fa-spin': isLoading}"></i>
            </button>
            
            <Transition enter-active-class="transition ease-out duration-200" enter-from-class="opacity-0 translate-y-2" enter-to-class="opacity-100 translate-y-0" leave-active-class="transition ease-in duration-150" leave-from-class="opacity-100 translate-y-0" leave-to-class="opacity-0 translate-y-2">
                <div v-if="selectedIds.size > 0" class="flex items-center gap-3">
                    <span class="text-xs font-bold text-slate-500 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
                        已选 <span class="text-indigo-600">{{ selectedIds.size }}</span>
                    </span>
                    
                    <button @click="deleteSelected" class="px-4 py-2 bg-white hover:bg-red-50 text-red-600 border border-red-200 hover:border-red-300 rounded-xl text-xs font-bold transition-all shadow-sm hover:shadow active:scale-95 flex items-center gap-2">
                        <i class="fa-regular fa-trash-can"></i> 删除
                    </button>

                    <button @click="startProcess" 
                        :disabled="isLoading"
                        class="px-5 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white border border-transparent rounded-xl text-xs font-bold transition-all shadow-md shadow-indigo-200 hover:shadow-lg hover:shadow-indigo-300 flex items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed active:scale-95">
                        <i class="fa-solid fa-cloud-arrow-up"></i> 
                        提交处理
                    </button>
                </div>
            </Transition>
        </div>
    </div>

    <div class="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-3 bg-slate-50/30">
        <div v-if="fullList.length === 0 && !isLoading" class="h-full flex flex-col items-center justify-center text-slate-400">
            <div class="w-24 h-24 bg-white rounded-full flex items-center justify-center shadow-sm mb-4 border border-slate-100">
                <i class="fa-regular fa-folder-open text-4xl opacity-50 text-slate-300"></i>
            </div>
            <p class="text-sm font-medium text-slate-500">队列中暂无任务</p>
        </div>

        <div v-else class="space-y-3">
             <div v-if="fullList.length > 0" class="flex items-center px-4 py-2.5 bg-white/80 border border-slate-200/80 rounded-xl shadow-sm backdrop-blur-sm sticky top-0 z-20 transition-all">
                <div @click="toggleSelectAll" class="group flex items-center cursor-pointer select-none">
                    <div class="w-5 h-5 rounded-md border flex items-center justify-center transition-all mr-3 shadow-sm"
                        :class="isAllSelected ? 'bg-indigo-500 border-indigo-500 text-white' : 'bg-white border-slate-300 text-transparent group-hover:border-indigo-400'">
                        <i class="fa-solid fa-check text-[10px]"></i>
                    </div>
                    <span class="text-xs font-bold text-slate-600 group-hover:text-indigo-600 transition-colors">全选本页</span>
                </div>
             </div>

             <TransitionGroup enter-active-class="transition-all duration-300 ease-out" enter-from-class="opacity-0 translate-y-4" enter-to-class="opacity-100 translate-y-0" leave-active-class="absolute opacity-0">
                 <div v-for="item in fullList" :key="item.id" 
                      class="group relative flex items-center p-3.5 bg-white border border-slate-100 hover:border-indigo-300 rounded-2xl transition-all duration-200 hover:shadow-md hover:-translate-y-0.5"
                      :class="{'ring-2 ring-indigo-500/50 bg-indigo-50/30 border-indigo-200 z-10': selectedIds.has(item.id)}">
                    
                    <div @click="toggleSelect(item.id)" class="flex-shrink-0 w-12 flex justify-center cursor-pointer py-2 self-stretch items-center">
                        <div class="w-5 h-5 rounded-md border flex items-center justify-center transition-all duration-200"
                             :class="selectedIds.has(item.id) ? 'bg-indigo-500 border-indigo-500 text-white scale-110' : 'bg-slate-50 border-slate-300 text-transparent group-hover:border-indigo-400 group-hover:bg-white'">
                            <i class="fa-solid fa-check text-[10px]"></i>
                        </div>
                    </div>

                    <div class="flex-1 min-w-0 px-2 py-0.5">
                        <div class="flex items-center gap-2.5 mb-1.5">
                            <span v-if="item.source_type === '189'" class="px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-orange-100 text-orange-700 tracking-wide">天翼</span>
                            <span v-else-if="item.source_type === 'quark'" class="px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-blue-100 text-blue-700 tracking-wide">夸克</span>
                            <span v-else class="px-2 py-0.5 rounded-md text-[10px] font-extrabold bg-slate-200 text-slate-700 tracking-wide">上传</span>

                            <h4 class="text-sm font-bold text-slate-700 truncate cursor-help" :title="item.cleanName">
                                {{ item.cleanName }}
                            </h4>
                        </div>
                        
                        <div class="flex items-center gap-4 text-xs text-slate-400 font-medium">
                            <span class="flex items-center gap-1.5 bg-slate-50 px-2 py-0.5 rounded border border-slate-100">
                                <i class="fa-regular fa-hard-drive text-slate-400"></i>{{ formatSize(item.size) }}
                            </span>
                            <span class="flex items-center gap-1.5 bg-slate-50 px-2 py-0.5 rounded border border-slate-100">
                                <i class="fa-solid fa-tv text-slate-400"></i> S{{ String(item.season).padStart(2,'0') }} E{{ String(item.episode).padStart(2,'0') }}
                            </span>
                            <span v-if="item.retry_count > 0" class="text-red-500 bg-red-50 px-2 py-0.5 rounded border border-red-100 flex items-center gap-1">
                                <i class="fa-solid fa-rotate-right text-[10px]"></i> 重试: {{ item.retry_count }}
                            </span>
                        </div>
                    </div>

                    <div class="flex-shrink-0 px-4 text-right">
                        <div v-if="item.task_id" class="flex flex-col items-end gap-1">
                            <span class="text-xs font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-lg border border-blue-100 flex items-center gap-1.5 shadow-sm">
                                <span class="relative flex h-2 w-2">
                                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                  <span class="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                                </span>
                                下载中
                            </span>
                        </div>
                        <div v-else-if="item.retry_count > 0 && currentFilter === 'failed'" class="flex flex-col items-end">
                            <span class="text-xs font-bold text-red-600 bg-red-50 px-2.5 py-1 rounded-lg border border-red-100 flex items-center gap-1.5">
                                <i class="fa-solid fa-circle-exclamation"></i> 失败
                            </span>
                        </div>
                        <div v-else class="flex flex-col items-end">
                             <span class="text-xs font-bold text-slate-500 bg-slate-100 px-2.5 py-1 rounded-lg border border-slate-200">
                                <i class="fa-regular fa-clock mr-1"></i> 等待处理
                            </span>
                        </div>
                    </div>
                 </div>
             </TransitionGroup>
        </div>
    </div>

    <div class="px-6 py-4 border-t border-slate-200/60 bg-white/80 backdrop-blur flex items-center justify-between z-10">
        <div class="flex items-center gap-3">
            <span class="text-xs text-slate-400 font-bold">每页显示</span>
            <div class="relative">
                <select v-model="pageSize" @change="changePageSize" class="appearance-none bg-white border border-slate-200 rounded-lg pl-3 pr-8 py-1.5 text-xs font-bold text-slate-600 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 hover:border-indigo-300 cursor-pointer shadow-sm transition-all">
                    <option :value="10">10 条</option>
                    <option :value="20">20 条</option>
                    <option :value="50">50 条</option>
                    <option :value="100">100 条</option>
                </select>
                <i class="fa-solid fa-chevron-down absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 pointer-events-none"></i>
            </div>
        </div>
        
        <div class="flex gap-2 items-center">
            <button @click="prevPage" :disabled="currentPage === 1" 
                class="w-9 h-9 flex items-center justify-center rounded-xl bg-white border border-slate-200 text-slate-500 text-xs hover:border-indigo-300 hover:text-indigo-600 hover:shadow-md hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:border-slate-200 disabled:hover:text-slate-500 disabled:hover:shadow-none disabled:hover:translate-y-0 transition-all active:scale-95">
                <i class="fa-solid fa-chevron-left"></i>
            </button>
            <span class="text-xs font-bold text-slate-600 bg-slate-100/50 border border-slate-200/60 px-4 py-2 rounded-xl min-w-[80px] text-center shadow-inner">
                {{ currentPage }} / {{ totalPages }}
            </span>
            <button @click="nextPage" :disabled="currentPage >= totalPages" 
                class="w-9 h-9 flex items-center justify-center rounded-xl bg-white border border-slate-200 text-slate-500 text-xs hover:border-indigo-300 hover:text-indigo-600 hover:shadow-md hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:border-slate-200 disabled:hover:text-slate-500 disabled:hover:shadow-none disabled:hover:translate-y-0 transition-all active:scale-95">
                <i class="fa-solid fa-chevron-right"></i>
            </button>
        </div>
    </div>
  </div>
</template>

<style scoped>
/* 隐藏原生滚动条，但保留滚动功能（兼容性） */
.custom-scrollbar::-webkit-scrollbar {
    width: 6px;
    height: 6px;
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
</style>