<script setup>
import { ref, shallowRef, shallowReactive, computed, onMounted } from 'vue'
import { formatSize, TMDB_GENRES } from '../utils/logic.js'
import { showToast } from '../utils/toast.js'
import { showConfirm } from '../utils/dialog.js'

// [逻辑完全保持不变]
const searchInput = ref('')
const isLoading = ref(false)
const isLoadingMore = ref(false)

// 核心数据容器
const rawData = shallowRef([]) // 存储已加载的所有数据
const detailCache = shallowReactive({})
const expandedId = ref(null)

// 筛选与排序
const filterType = ref('all') 
const sortType = ref('date_desc') 

// 分页状态
const currentPage = ref(1)
const pageSize = 50 
const totalItems = ref(0) 

// 辅助函数
const resolveGenres = (ids) => {
  if (!ids) return "";
  const arr = typeof ids === 'string' ? ids.split(',') : (Array.isArray(ids) ? ids : []);
  return arr.map(id => TMDB_GENRES[id] || id).join(',');
}

// 数据获取逻辑
const fetchData = async (page, isAppend = false) => {
  if (isAppend) {
    isLoadingMore.value = true
  } else {
    isLoading.value = true
    currentPage.value = 1 
  }

  try {
    const q = encodeURIComponent(searchInput.value.trim())
    const url = `./api/search?q=${q}&page=${page}&size=${pageSize}`
    
    const res = await fetch(url)
    const data = await res.json()
    
    let newList = []
    let total = 0

    if (Array.isArray(data)) {
        newList = data
        total = data.length 
    } else {
        newList = data.list || []
        total = data.total || 0
    }

    const optimizedData = newList.map(item => {
        item.genreText = resolveGenres(item.genres) 
        return Object.freeze(item) 
    })
    
    if (isAppend) {
        rawData.value = [...rawData.value, ...optimizedData]
    } else {
        rawData.value = optimizedData
    }
    
    totalItems.value = total
    currentPage.value = page

  } catch(e) {
    console.error(e)
    showToast("获取数据失败", "error")
  } finally {
    isLoading.value = false
    isLoadingMore.value = false
  }
}

const handleSearch = () => {
  fetchData(1, false)
}

const loadMore = () => {
  fetchData(currentPage.value + 1, true)
}

// 计算属性：仅负责前端筛选和排序（基于已加载的数据）
const displayList = computed(() => {
  let result = rawData.value 

  if (filterType.value !== 'all') {
    result = result.filter(item => item.type === filterType.value)
  }

  const sorted = [...result] 
  
  if (sortType.value === 'date_desc') {
    sorted.sort((a, b) => (b.last_updated || '').localeCompare(a.last_updated || ''))
  } else if (sortType.value === 'date_asc') {
    sorted.sort((a, b) => (a.last_updated || '').localeCompare(b.last_updated || ''))
  } else if (sortType.value === 'name_asc') {
    sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  return sorted
})

const hasMore = computed(() => {
  return rawData.value.length < totalItems.value
})

const toggleDetail = async (id) => {
  if (expandedId.value === id) {
    expandedId.value = null
    return
  }
  expandedId.value = id
  
  if (detailCache[id]) return

  try {
    const res = await fetch(`./api/details?id=${id}`)
    const data = await res.json()
    detailCache[id] = Object.freeze(data)
  } catch(e) {
    showToast("加载详情失败", "error")
  }
}

const copySeriesJson = async (id) => {
  const data = detailCache[id]
  if(!data) return

  const rawTitle = data.info.name.replace(/[\\/:*?"<>|]/g, '').trim()
  const year = data.info.year
  const commonPath = `${rawTitle} (${year}) {tmdbid-${data.info.tmdbId}}/`
  const isTV = data.episodes.some(ep => ep.season > 1 || ep.episode > 1)

  const files = data.episodes.map(ep => {
    if(isTV) {
      const seasonFolder = `Season ${String(ep.season).padStart(2,'0')}`
      return { path: `${seasonFolder}/${ep.cleanName}`, etag: ep.etag, size: ep.size }
    } else {
      return { path: `${ep.cleanName}`, etag: ep.etag, size: ep.size }
    }
  })

  const json = { scriptVersion: "3.0.3", exportVersion: "1.0", usesBase62EtagsInExport: false, commonPath, files, totalFilesCount: files.length, totalSize: files.reduce((a,b)=>a+b.size, 0) }
  
  try {
    await navigator.clipboard.writeText(JSON.stringify(json, null, 2))
    showToast("已复制到剪贴板", "success")
  } catch(err) {
    showToast("复制失败", "error")
  }
}

// [核心修改] 删除整个剧集 - 使用 GlobalConfirm
const deleteSeries = async (id, name) => {
    // 唤起全局确认弹窗
    const confirmed = await showConfirm({
        title: '确定要删除剧集吗?',
        text: `即将删除 <b>${name}</b><br><span style="color:#ef4444;font-size:12px">这将清除数据库中所有关联集数和字幕，不可恢复！</span>`,
        type: 'danger',
        confirmText: '确认删除',
        cancelText: '取消'
    });

    if (!confirmed) return;

    try {
        const res = await fetch(`./api/delete/series?id=${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast("剧集已删除", "success")
            // 移除列表项并关闭详情
            rawData.value = rawData.value.filter(item => item.tmdbId !== id);
            totalItems.value--;
            if (expandedId.value === id) expandedId.value = null;
        } else {
            throw new Error(data.error);
        }
    } catch (e) {
      console.log(e);
      
        showToast("删除失败", "error")
    }
}

// [核心修改] 删除单个文件 - 使用 GlobalConfirm
const deleteEpisode = async (rowId, tmdbId, fileName) => {
    const confirmed = await showConfirm({
        title: '删除文件?',
        text: `确认从数据库中移除此文件？<br><span style="font-family:monospace;font-size:11px;color:#64748b">${fileName}</span>`,
        type: 'warning',
        confirmText: '删除',
        cancelText: '取消'
    });

    if (!confirmed) return;

    try {
        const res = await fetch(`./api/delete/episode?id=${rowId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast("文件已删除", "success")
            
            // 局部刷新：从 detailCache 中移除该文件
            if (detailCache[tmdbId] && detailCache[tmdbId].episodes) {
                const newEpisodes = detailCache[tmdbId].episodes.filter(ep => ep.id !== rowId);
                detailCache[tmdbId] = Object.freeze({ ...detailCache[tmdbId], episodes: newEpisodes });
            }
        } else {
            throw new Error(data.error);
        }
    } catch (e) {
        showToast("删除失败: " + e.message, "error")
    }
}

onMounted(() => {
    handleSearch()
})
</script>

<template>
  <div class="h-full flex flex-col relative">
    
    <div class="mb-4 sticky top-0 z-30 -mx-1 px-1 py-1">
      <div class="bg-white/80 backdrop-blur-xl p-3 sm:p-4 rounded-2xl shadow-lg shadow-slate-200/50 border border-white/60 transition-all duration-300">
        
        <div class="flex gap-3 mb-3 sm:mb-4">
          <div class="relative flex-1 group">
            <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <i class="fa-solid fa-magnifying-glass text-slate-400 group-focus-within:text-indigo-500 transition-colors duration-300"></i>
            </div>
            <input type="text" v-model="searchInput" placeholder="搜索电影、剧集..." 
              class="w-full pl-11 pr-4 py-2.5 sm:py-3 bg-slate-50/80 border border-slate-200 hover:border-indigo-300 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none text-sm font-medium rounded-xl transition-all duration-300 placeholder-slate-400" 
              @keyup.enter="handleSearch">
          </div>
          <button @click="handleSearch" class="w-12 flex items-center justify-center bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-xl shadow-md shadow-indigo-200 hover:shadow-indigo-300 transition-all active:scale-95 duration-200">
            <i class="fa-solid fa-arrow-right"></i>
          </button>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex bg-slate-100/80 p-1 rounded-lg border border-slate-200/50">
              <button @click="filterType = 'all'" 
                :class="filterType==='all' ? 'bg-white text-indigo-600 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700'" 
                class="px-3 sm:px-4 py-1.5 text-xs font-bold rounded-md transition-all duration-200">全部</button>
              <button @click="filterType = 'movie'" 
                :class="filterType==='movie' ? 'bg-white text-orange-500 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700'" 
                class="px-3 sm:px-4 py-1.5 text-xs font-bold rounded-md transition-all duration-200">电影</button>
              <button @click="filterType = 'tv'" 
                :class="filterType==='tv' ? 'bg-white text-blue-500 shadow-sm ring-1 ring-black/5' : 'text-slate-500 hover:text-slate-700'" 
                class="px-3 sm:px-4 py-1.5 text-xs font-bold rounded-md transition-all duration-200">剧集</button>
          </div>

          <div class="relative group">
              <select v-model="sortType" class="appearance-none bg-slate-50 border border-slate-200 text-slate-600 text-xs font-bold py-2 pl-4 pr-9 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 hover:bg-white hover:border-indigo-300 transition-all cursor-pointer shadow-sm">
                  <option value="date_desc">最近更新</option>
                  <option value="date_asc">最早入库</option>
                  <option value="name_asc">名称 A-Z</option>
              </select>
              <i class="fa-solid fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 pointer-events-none group-hover:text-indigo-500 transition-colors"></i>
          </div>
        </div>
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-1 pb-safe">
        
        <div v-if="isLoading" class="space-y-4 pt-2">
            <div v-for="i in 5" :key="i" class="bg-white/60 border border-white/50 rounded-2xl p-4 flex items-center gap-4 animate-pulse">
                <div class="w-16 h-16 bg-slate-200 rounded-xl"></div>
                <div class="flex-1 space-y-2">
                    <div class="h-4 bg-slate-200 rounded w-1/3"></div>
                    <div class="h-3 bg-slate-200 rounded w-1/4"></div>
                </div>
            </div>
        </div>

        <div v-else-if="displayList.length === 0" class="flex flex-col items-center justify-center py-20 text-slate-400">
            <div class="w-24 h-24 bg-slate-50 rounded-full flex items-center justify-center mb-6 shadow-inner ring-1 ring-slate-100">
                <i class="fa-regular fa-folder-open text-4xl opacity-30 text-slate-400"></i>
            </div>
            <p class="text-sm font-medium">没有找到相关资源</p>
        </div>

        <div v-else class="space-y-3 pb-8">
          <TransitionGroup enter-active-class="transition ease-out duration-300" enter-from-class="opacity-0 translate-y-4" enter-to-class="opacity-100 translate-y-0">
          <div v-for="item in displayList" :key="item.tmdbId" 
            class="bg-white/80 border border-slate-100 rounded-2xl shadow-sm hover:shadow-lg hover:shadow-indigo-500/5 hover:-translate-y-0.5 transition-all duration-300 cursor-pointer overflow-hidden group backdrop-blur-sm">
            
            <div class="flex justify-between items-center p-4" @click="toggleDetail(item.tmdbId)">
              <div class="flex items-center gap-4 min-w-0 flex-1">
                <div class="w-14 h-14 sm:w-16 sm:h-16 rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 border border-white text-slate-400 flex items-center justify-center font-bold text-2xl flex-shrink-0 shadow-sm relative overflow-hidden group-hover:shadow-md transition-all">
                  <span v-if="!item.poster_path" class="z-10 opacity-50">{{ item.name.substr(0,1) }}</span>
                  <img v-else :src="`https://image.tmdb.org/t/p/w92${item.poster_path}`" class="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" loading="lazy">
                  <div class="absolute inset-0 ring-1 ring-inset ring-black/5 rounded-xl z-20"></div>
                </div>
                
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline gap-2 mb-1.5">
                    <div class="font-bold text-slate-700 text-sm sm:text-base truncate group-hover:text-indigo-600 transition-colors">{{ item.name }}</div>
                  </div>
                  <div class="flex items-center text-xs gap-2 flex-wrap">
                    <span class="px-1.5 py-0.5 rounded-[4px] font-extrabold uppercase tracking-wider text-[9px] border shadow-sm select-none" 
                      :class="item.type==='movie' ? 'bg-orange-50 text-orange-600 border-orange-100' : 'bg-blue-50 text-blue-600 border-blue-100'">
                      {{ item.type }}
                    </span>
                    <span class="text-slate-500 font-mono bg-slate-50 px-1.5 py-0.5 rounded border border-slate-200">{{ item.year }}</span>
                    <div class="flex gap-1 overflow-hidden">
                      <span v-for="g in (item.genreText || '').split(',').slice(0,2)" :key="g" class="text-[10px] text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded-full border border-slate-100 truncate max-w-[60px]">{{ g }}</span>
                    </div>
                  </div>
                </div>
              </div>
              
              <div class="pl-2 text-slate-300 group-hover:text-indigo-400 transition-colors">
                  <i class="fa-solid fa-chevron-down transition-transform duration-300" :class="{'rotate-180': expandedId === item.tmdbId}"></i>
              </div>
            </div>

            <div v-show="expandedId === item.tmdbId" class="border-t border-slate-100 bg-slate-50/50 shadow-inner relative">
              <div class="absolute inset-0 opacity-[0.03] pointer-events-none" style="background-image: repeating-linear-gradient(45deg, #000 0, #000 1px, transparent 0, transparent 50%); background-size: 10px 10px;"></div>
              
              <div class="p-4 relative z-10">
                <div v-if="!detailCache[item.tmdbId]" class="text-center text-sm text-slate-400 py-6 flex items-center justify-center gap-2">
                  <i class="fa-solid fa-spinner fa-spin text-indigo-500"></i> <span class="text-xs">获取文件详情...</span>
                </div>
                
                <div v-else class="animate-in fade-in slide-in-from-top-2 duration-300 space-y-3">
                  <div class="flex flex-wrap justify-between items-center gap-2 bg-white/60 p-2 rounded-lg border border-slate-200/50">
                    <span class="text-[10px] font-bold text-slate-500 flex items-center gap-1.5 px-2">
                      <i class="fa-solid fa-hard-drive text-indigo-500"></i> 
                      {{ formatSize(detailCache[item.tmdbId].episodes.reduce((a,b)=>a+Number(b.size), 0)) }} 
                      <span class="text-slate-300">|</span> 
                      {{ detailCache[item.tmdbId].episodes.length }} 个文件
                    </span>
                    
                    <div class="flex gap-2">
                        <button @click.stop="deleteSeries(item.tmdbId, item.name)" 
                                class="px-2.5 py-1.5 bg-white hover:bg-red-50 text-red-500 border border-slate-200 hover:border-red-200 text-[10px] font-bold rounded-lg transition-all shadow-sm active:scale-95 flex items-center gap-1">
                            <i class="fa-regular fa-trash-can"></i> 删除
                        </button>
                        
                        <button @click.stop="copySeriesJson(item.tmdbId)" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white border border-transparent text-[10px] font-bold rounded-lg transition-all shadow-md shadow-indigo-200 hover:shadow-indigo-300 active:scale-95 flex items-center gap-1">
                          <i class="fa-regular fa-copy"></i> 复制JSON
                        </button>
                    </div>
                  </div>
                  
                  <div class="max-h-64 overflow-y-auto custom-scrollbar space-y-1.5 pr-1">
                    <div v-for="ep in detailCache[item.tmdbId].episodes" :key="ep.id" 
                      class="flex justify-between items-center text-xs text-slate-600 py-2 px-3 bg-white border border-slate-100 rounded-lg hover:border-indigo-200 hover:bg-indigo-50/30 transition-all group/item">
                      
                      <div class="truncate flex-1 flex items-center mr-3 gap-2" :title="ep.cleanName">
                        <i class="fa-regular fa-file-video text-slate-300 group-hover/item:text-indigo-400"></i>
                        <span class="truncate font-mono font-medium text-[11px]">{{ ep.cleanName }}</span>
                      </div>

                      <div class="flex items-center gap-3 flex-shrink-0">
                          <span class="font-mono text-slate-400 text-[9px]">{{ formatSize(ep.size) }}</span>
                          
                          <button @click.stop="deleteEpisode(ep.id, item.tmdbId, ep.cleanName)" 
                                  class="w-5 h-5 flex items-center justify-center rounded bg-slate-100 text-slate-300 hover:bg-red-500 hover:text-white transition-all opacity-0 group-hover/item:opacity-100 focus:opacity-100"
                                  title="删除此文件">
                              <i class="fa-solid fa-xmark text-[10px]"></i>
                          </button>
                      </div>

                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </TransitionGroup>
        </div>

        <div v-if="hasMore" class="pt-4 pb-8 flex justify-center">
          <button @click="loadMore" :disabled="isLoadingMore"
             class="px-6 py-2.5 bg-white border border-slate-200 hover:border-indigo-300 text-slate-500 hover:text-indigo-600 rounded-full text-xs font-bold shadow-sm hover:shadow-md transition-all active:scale-95 flex items-center gap-2 group disabled:opacity-70 disabled:cursor-not-allowed">
              <span v-if="isLoadingMore" class="flex items-center gap-2"><i class="fa-solid fa-circle-notch fa-spin"></i> 加载中...</span>
              <span v-else class="flex items-center gap-2">加载更多 <i class="fa-solid fa-chevron-down group-hover:translate-y-0.5 transition-transform"></i></span>
          </button>
        </div>
        <div v-else-if="displayList.length > 0" class="text-center py-8">
            <span class="px-3 py-1 rounded-full bg-slate-100 text-[10px] text-slate-400 uppercase tracking-widest font-bold border border-slate-200/60">
               End of Library
            </span>
        </div>
    </div>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: #cbd5e1;
  border-radius: 20px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background-color: #94a3b8;
}
</style>