<script setup>
import { ref, computed, onUnmounted } from 'vue'
import { 
  rebuildJsonWithTmdb, 
  autoGroupFiles, 
  formatSize 
} from '../utils/logic.js'
import { showToast } from '../utils/toast.js'
import { globalConfig, initConfig } from '../utils/configStore.js'

// =========================
// 逻辑完全保持不变
// =========================
const universalInput = ref('')
const detectState = ref({ text: '', style: 'opacity-0 scale-90' })
const showLinkOptions = ref(false)
const panType = ref('123')
const sharePassword = ref('')
const shareUrl = ref('')

const isParsing = ref(false)
const parseStatusText = ref('处理中...')
const parsePercent = ref(0)
const eventSourceInstance = ref(null)

const importQueue = ref([])        
const isBatchMatching = ref(false) 
const isBatchSubmitting = ref(false) 
const activeEditItem = ref(null)   

const tmdbSearchQuery = ref('')
const tmdbDropdownList = ref([])
const isSearchingTmdb = ref(false)

// ----------------------------------------------------------------
// 输入处理
// ----------------------------------------------------------------
let inputTimer = null
const handleInput = () => {
  clearTimeout(inputTimer)
  inputTimer = setTimeout(() => {
    const val = universalInput.value.trim()
    if (!val) { resetUI(); return }

    if (val.startsWith('{') && val.endsWith('}')) {
      try {
        const j = JSON.parse(val)
        if (j.files) {
          setDetectState('JSON 数据', 'success')
          showLinkOptions.value = false
          shareUrl.value = ''
          panType.value = 'json'
          processParsedResult(j) 
          return
        }
      } catch(e) {}
    }

// 2. 网盘类型识别
    let type = ''
    if (/123(pan|865|684|912)\.(com|cn)/.test(val)) type = '123'
    else if (val.includes('189.cn')) type = '189'
    else if (val.includes('quark.cn')) type = 'quark'

    if (type) {
      setDetectState(`${type} 网盘`, 'info')
      
      // [修正点2] 使用更宽松的正则提取 URL，防止漏掉参数
      const urlMatch = val.match(/https?:\/\/[^\s"']+/)
      // 提取中文“密码：xxxx”的情况
      const pwdMatch = val.match(/(提取码|密码|访问码|接收码)[：:\s]*([a-zA-Z0-9]{4,20})/)
      
      showLinkOptions.value = true
      panType.value = type
      
      if (urlMatch) {
        shareUrl.value = urlMatch[0]
        
        // 尝试从 URL 参数中提取密码
        try {
            const urlObj = new URL(urlMatch[0])
            if (type === '123') { 
                sharePassword.value = urlObj.searchParams.get('pwd') || '' 
            }
            if (type === '189') { 
                sharePassword.value = urlObj.searchParams.get('code') || '' 
            }
        } catch(e) {}
      }

      // 如果 URL 里没找到密码，再看有没有中文正则匹配到的
      if (pwdMatch && !sharePassword.value) {
          sharePassword.value = pwdMatch[2]
      }
      return
    }
    setDetectState('未知格式', 'error')
  }, 500)
}

const setDetectState = (text, type) => {
  let color = type === 'success' ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 
              type === 'info' ? 'bg-indigo-100 text-indigo-700 border-indigo-200' : 
              'bg-red-100 text-red-700 border-red-200'
  detectState.value = { text, style: `opacity-100 scale-100 ${color} border shadow-sm` }
}

const resetUI = () => {
  showLinkOptions.value = false
  detectState.value = { text: '', style: 'opacity-0 scale-90' }
  importQueue.value = []
  activeEditItem.value = null
  shareUrl.value = ''
  sharePassword.value = ''
  panType.value = '123'
}

const clearInput = () => {
  universalInput.value = ''
  resetUI()
}

// ----------------------------------------------------------------
// 链接解析
// ----------------------------------------------------------------
const startParsing = () => {
  const cookie = globalConfig.quarkCookie || ''
  if (panType.value === 'quark' && !cookie) {
    showToast("请设置夸克Cookie", "error")
    return
  }
  
  isParsing.value = true
  parsePercent.value = 0
  
  if (eventSourceInstance.value) {
      eventSourceInstance.value.close()
  }

  const params = new URLSearchParams({ 
    panType: panType.value, 
    shareUrl: shareUrl.value, 
    sharePassword: sharePassword.value, 
    cookie: cookie || '' 
  })

  const es = new EventSource(`./api/stream?${params}`)
  eventSourceInstance.value = es 

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'phase') {
      parseStatusText.value = msg.data.message
      parsePercent.value = 10
    } else if (msg.type === 'scan') {
      parseStatusText.value = `发现 ${msg.data.count} 个文件`
      parsePercent.value = 40
    } else if (msg.type === 'progress') {
      parsePercent.value = Math.floor(40 + (msg.data.processed / msg.data.total) * 50)
      parseStatusText.value = `计算指纹 (${msg.data.processed}/${msg.data.total})`
    } else if (msg.type === 'result') {
      es.close()
      eventSourceInstance.value = null
      parsePercent.value = 100
      isParsing.value = false
      processParsedResult(msg.data.rapidTransferJson)
    } else if (msg.type === 'error') {
      es.close()
      eventSourceInstance.value = null
      isParsing.value = false
      showToast(msg.data.message, "error")
    }
  }
  
  es.onerror = () => { 
      es.close(); 
      eventSourceInstance.value = null;
      isParsing.value = false; 
  }
}

onUnmounted(() => {
    if (eventSourceInstance.value) {
        eventSourceInstance.value.close()
        eventSourceInstance.value = null
    }
})

// ----------------------------------------------------------------
// 队列处理
// ----------------------------------------------------------------
const getOriginalName = (item) => {
    if (!item.files || item.files.length === 0) return '未知文件';
    const path = item.files[0].path;
    const parts = path.split('/');
    return parts[parts.length - 1];
}

const toggleExpand = (item) => {
    item.expanded = !item.expanded
}

const getFilePreviewTag = (file) => {
    if (file._previewEpStr) return file._previewEpStr;
    return 'File';
}

const processParsedResult = (rawJson) => {
  if (!rawJson || !rawJson.files) return

  const groups = autoGroupFiles(rawJson)
  
  importQueue.value = groups.map((g, index) => ({
    id: index,
    key: g.key,
    searchQuery: g.searchQuery, 
    year: g.year,
    tmdbId: g.tmdbId, 
    isTV: g.isTV,
    files: g.files,
    expanded: false,
    
    status: 'pending', 
    tmdbInfo: null,    
    finalJson: null,   
    errorMsg: ''
  }))

  runBatchAutoMatch()
}

const runBatchAutoMatch = async () => {
  isBatchMatching.value = true
  const apiKey = globalConfig.tmdbKey || '';
  
  if (!apiKey) {
    showToast("未配置 TMDB Key，请手动搜索", "warning")
    importQueue.value.forEach(item => { item.status = 'failed'; item.errorMsg = '缺少 API Key'; })
    isBatchMatching.value = false
    return
  }

  const queue = importQueue.value.filter(i => i.status === 'pending')
  const BATCH_SIZE = 3 
  
  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const batch = queue.slice(i, i + BATCH_SIZE)
    await Promise.all(batch.map(item => autoMatchSingleItem(item, apiKey)))
    if (i + BATCH_SIZE < queue.length) await new Promise(r => setTimeout(r, 250))
  }
  
  isBatchMatching.value = false
}

const getResultYear = (res) => {
  const date = res.first_air_date || res.release_date || '';
  return date ? parseInt(date.split('-')[0]) : 0;
}

const findBestMatch = (results, targetYear) => {
  if (!results || results.length === 0) return null;
  if (!targetYear) return results[0];

  const target = parseInt(targetYear);
  const exactMatch = results.find(res => getResultYear(res) === target);
  if (exactMatch) return exactMatch;

  const fuzzyMatch = results.find(res => Math.abs(getResultYear(res) - target) <= 1);
  if (fuzzyMatch) return fuzzyMatch;

  return null; 
}

const autoMatchSingleItem = async (item, apiKey) => {
  item.status = 'loading'
  const type = item.isTV ? 'tv' : 'movie'
  const directId = item.tmdbId
  
  try {
    let bestMatch = null
    
    if (directId) {
        const url = `https://api.themoviedb.org/3/${type}/${directId}?api_key=${apiKey}&language=zh-CN`
        const res = await fetch(url)
        if (res.ok) {
            bestMatch = await res.json()
            bestMatch.media_type = type 
            bestMatch.genre_ids = bestMatch.genres.map(({id})=>id);
        }
    }

    if (!bestMatch) {
        const q = encodeURIComponent(item.searchQuery)
        const targetYear = item.year 
        
        const yearParam = targetYear ? `&${type === 'movie' ? 'primary_release_year' : 'first_air_date_year'}=${targetYear}` : ''
        let url = `https://api.themoviedb.org/3/search/${type}?api_key=${apiKey}&query=${q}&language=zh-CN${yearParam}`
        
        let res = await fetch(url)
        let data = await res.json()
        let candidates = data.results || []
        bestMatch = findBestMatch(candidates, targetYear)

        if (!bestMatch && targetYear) {
           url = `https://api.themoviedb.org/3/search/${type}?api_key=${apiKey}&query=${q}&language=zh-CN`
           res = await fetch(url)
           data = await res.json()
           candidates = data.results || []
           bestMatch = findBestMatch(candidates, targetYear)
        }
    }

    if (bestMatch) {
      applyTmdbMatch(item, bestMatch)
    } else {
       item.status = 'failed'
       item.errorMsg = directId ? `ID ${directId} 无效且搜索无果` : '未找到匹配项'
    }
  } catch (e) {
    console.error(e)
    item.status = 'failed'
    item.errorMsg = 'API 请求错误'
  }
}

const applyTmdbMatch = (item, tmdbData) => {
  const type = tmdbData.media_type || (tmdbData.title ? 'movie' : 'tv') 
  const title = tmdbData.name || tmdbData.title
  const year = (tmdbData.first_air_date || tmdbData.release_date || '').split('-')[0]
  const originalLanguage = tmdbData.original_language || '';
  
  let originCountry = '';
  if (tmdbData.origin_country && Array.isArray(tmdbData.origin_country)) {
      originCountry = tmdbData.origin_country.join(',');
  } else if (tmdbData.production_countries && Array.isArray(tmdbData.production_countries)) {
      originCountry = tmdbData.production_countries.map(c => c.iso_3166_1).join(',');
  }

  item.tmdbInfo = {
    id: tmdbData.id,
    name: title,
    year: year,
    type: type,
    poster: tmdbData.poster_path,
    overview: tmdbData.overview,
    genres: tmdbData.genre_ids,
    originalLanguage,
    originCountry
  }
  
  const sourceType = (panType.value !== 'json' && shareUrl.value) ? panType.value : 'json';
  
  item.finalJson = rebuildJsonWithTmdb(
    item.files, 
    { id: tmdbData.id, name: title, year }, 
    type, 
    sourceType
  )
  
  item.status = 'matched'
}

// ----------------------------------------------------------------
// 手动修正
// ----------------------------------------------------------------
const openManualFix = (item) => {
  activeEditItem.value = item
  tmdbSearchQuery.value = item.searchQuery 
  tmdbDropdownList.value = []
  searchTmdbManual()
}

const closeManualFix = () => {
  activeEditItem.value = null
}

const searchTmdbManual = async () => {
  if (!tmdbSearchQuery.value) return
  isSearchingTmdb.value = true
  const apiKey = globalConfig.tmdbKey || ''
  
  try {
    const q = encodeURIComponent(tmdbSearchQuery.value)
    const res = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${apiKey}&query=${q}&language=zh-CN`)
    const data = await res.json()
    tmdbDropdownList.value = (data.results || []).filter(i => i.media_type !== 'person')
  } catch(e) {
    showToast("搜索失败，请检查网络", "error")
  } finally { 
    isSearchingTmdb.value = false 
  }
}

const selectManualMatch = (match) => {
  if (activeEditItem.value) {
    applyTmdbMatch(activeEditItem.value, match)
    closeManualFix()
  }
}

// ----------------------------------------------------------------
// 提交
// ----------------------------------------------------------------
const validItemsCount = computed(() => importQueue.value.filter(i => i.status === 'matched').length)

const submitAll = async () => {
  const itemsToSubmit = importQueue.value.filter(i => i.status === 'matched')
  if (itemsToSubmit.length === 0) return
  
  isBatchSubmitting.value = true
  let successCount = 0
  
  for (const item of itemsToSubmit) {
    item.status = 'loading' 
    try {
      const payload = {
        tmdbId: item.tmdbInfo.id,
        seriesName: item.tmdbInfo.name,
        seriesYear: item.tmdbInfo.year,
        type: item.tmdbInfo.type,
        genres: (item.tmdbInfo.genres || []).join(','),
        originalLanguage: item.tmdbInfo.originalLanguage,
        originCountry: item.tmdbInfo.originCountry,
        sourceType: (panType.value !== 'json' && shareUrl.value) ? panType.value : 'json',
        jsonData: item.finalJson
      }
      
      const res = await fetch('./api/submit', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      })
      const json = await res.json()
      
      if (json.success) {
        item.status = 'done'
        successCount++
      } else {
        item.status = 'failed'
        item.errorMsg = json.error || '后台错误'
      }
    } catch(e) {
      item.status = 'failed'
      item.errorMsg = '网络请求失败'
    }
  }
  
  isBatchSubmitting.value = false
  
  showToast(`批量处理完成: 成功 ${successCount} / 总计 ${itemsToSubmit.length}`, successCount === itemsToSubmit.length ? "success" : "warning")
}

const toggleIgnore = (item) => {
  if (item.status === 'ignored') {
    item.status = 'pending'
    const apiKey = globalConfig.tmdbKey || ''
    autoMatchSingleItem(item, apiKey)
  } else {
    item.status = 'ignored'
  }
}
</script>

<template>
  <div class="h-full flex flex-col gap-5 relative">
    
    <div class="bg-white/80 backdrop-blur-xl border border-slate-100 rounded-2xl shadow-sm p-4 sm:p-5 transition-all duration-300">
      <div class="flex justify-between items-center mb-3">
        <h3 class="text-xs font-extrabold text-slate-400 uppercase tracking-wider flex items-center gap-2">
          <span class="bg-indigo-100 text-indigo-600 w-5 h-5 rounded-full flex items-center justify-center text-[10px]">1</span> 
          资源录入
        </h3>
        <button v-if="importQueue.length > 0" @click="clearInput" class="text-[10px] text-red-500 hover:text-red-600 bg-red-50 hover:bg-red-100 px-2 py-1 rounded transition-colors font-bold">
          <i class="fa-solid fa-trash-can mr-1"></i>清空
        </button>
      </div>
      
      <div class="relative group">
        <textarea v-model="universalInput" @input="handleInput" :disabled="importQueue.length > 0"
          class="w-full h-24 p-4 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none font-mono text-xs text-slate-600 resize-none transition-all shadow-inner disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-slate-400" 
          placeholder="在此粘贴分享链接 (123/夸克/189) 或 RapidTransfer JSON..."></textarea>
        
        <div class="absolute bottom-3 right-3 px-2.5 py-1 rounded-md text-[10px] font-bold transition-all duration-300 transform flex items-center gap-1.5 pointer-events-none" 
             :class="detectState.style">
             <i v-if="detectState.style.includes('success')" class="fa-solid fa-check"></i>
             <i v-else-if="detectState.style.includes('info')" class="fa-solid fa-link"></i>
             <i v-else class="fa-solid fa-exclamation-circle"></i>
             {{ detectState.text }}
        </div>
      </div>

      <Transition enter-active-class="transition ease-out duration-300" enter-from-class="opacity-0 -translate-y-2 h-0 overflow-hidden" enter-to-class="opacity-100 translate-y-0 h-auto overflow-hidden">
        <div v-if="showLinkOptions" class="mt-3">
           <div class="p-3 bg-indigo-50/50 rounded-xl border border-indigo-100 flex items-center gap-3">
                <div class="flex-1 relative">
                    <i class="fa-solid fa-key absolute left-3 top-1/2 -translate-y-1/2 text-indigo-300 text-xs"></i>
                    <input type="text" v-model="sharePassword" class="w-full pl-8 pr-3 py-2 bg-white rounded-lg border border-indigo-100 text-xs outline-none focus:border-indigo-400 text-slate-600 placeholder:text-indigo-200" placeholder="提取码 (自动识别)">
                </div>
                <button @click="startParsing" :disabled="isParsing" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 disabled:bg-indigo-400 transition-colors shadow-sm shadow-indigo-200 flex items-center gap-2 min-w-[100px] justify-center">
                    <i v-if="isParsing" class="fa-solid fa-circle-notch fa-spin"></i>
                    {{ isParsing ? `${parsePercent}%` : '开始解析' }}
                </button>
           </div>
           <p v-if="isParsing" class="text-[10px] text-center mt-2 text-indigo-400 font-mono animate-pulse">{{ parseStatusText }}</p>
        </div>
      </Transition>
    </div>

    <div v-if="importQueue.length > 0" class="flex-1 flex flex-col min-h-0 bg-white/80 backdrop-blur-xl border border-slate-100 rounded-2xl shadow-sm overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
        
        <div class="px-5 py-3 border-b border-slate-100 bg-white/50 backdrop-blur flex justify-between items-center z-10">
           <h3 class="text-xs font-extrabold text-slate-400 uppercase tracking-wider flex items-center gap-2">
              <span class="bg-indigo-100 text-indigo-600 w-5 h-5 rounded-full flex items-center justify-center text-[10px]">2</span> 
              智能匹配
           </h3>
           <div class="flex items-center gap-3">
              <span v-if="isBatchMatching" class="text-[10px] text-indigo-500 bg-indigo-50 px-2 py-1 rounded-md font-bold flex items-center gap-1.5">
                  <i class="fa-solid fa-circle-notch fa-spin"></i> TMDB 匹配中...
              </span>
              <span class="text-[10px] font-bold bg-slate-100 text-slate-500 px-2 py-1 rounded-md">
                 共 {{ importQueue.length }} 条
              </span>
           </div>
        </div>

        <div class="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-3 relative">
            <div v-for="(item, idx) in importQueue" :key="item.id" 
                 class="bg-white border rounded-xl transition-all duration-300 relative group overflow-hidden hover:shadow-md"
                 :class="[
                    item.status === 'ignored' ? 'border-slate-100 opacity-60 grayscale' : 
                    item.status === 'done' ? 'border-emerald-200 bg-emerald-50/10' : 
                    item.status === 'failed' ? 'border-red-200 bg-red-50/10' : 
                    item.status === 'matched' ? 'border-indigo-200 hover:border-indigo-300' : 'border-slate-200'
                 ]">
                
                <div class="p-3 flex gap-4 items-start relative z-10">
                    <div class="w-14 h-20 rounded-lg bg-slate-100 flex-shrink-0 overflow-hidden relative border border-slate-200 flex items-center justify-center shadow-sm">
                        <img v-if="item.tmdbInfo && item.tmdbInfo.poster" :src="`https://image.tmdb.org/t/p/w92${item.tmdbInfo.poster}`" class="w-full h-full object-cover">
                        <div v-else-if="item.status === 'loading'" class="text-indigo-400"><i class="fa-solid fa-circle-notch fa-spin"></i></div>
                        <div v-else-if="item.status === 'failed'" class="text-red-400 text-lg"><i class="fa-solid fa-triangle-exclamation"></i></div>
                        <div v-else class="text-slate-300 font-black text-xl select-none">{{ item.searchQuery.substr(0,1).toUpperCase() }}</div>
                        
                        <div v-if="item.status === 'done'" class="absolute inset-0 bg-emerald-500/90 flex items-center justify-center text-white text-xl animate-in zoom-in duration-200"><i class="fa-solid fa-check"></i></div>
                    </div>
                    
                    <div class="flex-1 min-w-0 flex flex-col h-20 justify-between">
                        <div>
                            <div class="flex justify-between items-start">
                                <h3 class="text-sm font-bold truncate pr-2" :class="item.status === 'failed' ? 'text-red-600' : 'text-slate-700'" :title="item.searchQuery">
                                    {{ item.status === 'matched' || item.status === 'done' ? item.tmdbInfo.name : item.searchQuery }}
                                </h3>
                                <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button @click="openManualFix(item)" v-if="item.status !== 'done'" class="w-6 h-6 rounded-md flex items-center justify-center transition-colors" :class="item.status === 'failed' ? 'bg-red-100 text-red-600 hover:bg-red-200' : 'bg-slate-100 text-slate-500 hover:bg-indigo-100 hover:text-indigo-600'" title="手动搜索修正"><i class="fa-solid fa-magnifying-glass text-[10px]"></i></button>
                                    <button @click="toggleIgnore(item)" v-if="item.status !== 'done'" class="w-6 h-6 rounded-md bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors" :title="item.status==='ignored'?'恢复':'忽略'"><i class="text-[10px]" :class="item.status==='ignored' ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'"></i></button>
                                </div>
                            </div>
                            
                            <div class="flex flex-wrap gap-1.5 mt-1">
                                <span v-if="item.year" class="text-[10px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">{{ item.year }}</span>
                                <span v-if="item.isTV" class="text-[10px] font-bold text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">TV</span>
                                <span class="text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100 truncate max-w-[150px]"><i class="fa-regular fa-file mr-1"></i>{{ getOriginalName(item) }}</span>
                            </div>
                        </div>

                        <div class="flex justify-between items-end mt-1">
                            <div class="text-[10px] font-medium">
                                <span v-if="item.status === 'loading'" class="text-indigo-400 flex items-center gap-1"><i class="fa-solid fa-spinner fa-spin"></i> 正在处理...</span>
                                <span v-else-if="item.status === 'failed'" class="text-red-500 flex items-center gap-1"><i class="fa-solid fa-circle-exclamation"></i> {{ item.errorMsg || '无匹配' }}</span>
                                <span v-else-if="item.status === 'matched'" class="text-emerald-600 flex items-center gap-1"><i class="fa-solid fa-link"></i> TMDB {{ item.tmdbInfo.id }}</span>
                                <span v-else-if="item.status === 'ignored'" class="text-slate-400">已忽略</span>
                            </div>
                            <button @click="toggleExpand(item)" class="text-[10px] text-slate-400 hover:text-indigo-500 flex items-center gap-1 transition-colors">
                                {{ item.files.length }} 个文件 <i class="fa-solid fa-chevron-down transition-transform duration-200" :class="{'rotate-180': item.expanded}"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <div v-if="item.expanded" class="bg-slate-50 border-t border-slate-100 p-2 text-[10px] animate-in slide-in-from-top-1 duration-200">
                    <div class="max-h-32 overflow-y-auto custom-scrollbar space-y-1">
                        <div v-for="(file, fIdx) in item.files" :key="fIdx" class="flex justify-between items-center p-1.5 rounded bg-white border border-slate-200/50">
                            <span class="truncate w-3/4 text-slate-600" :title="file.path.split('/').pop()">{{ file.path.split('/').pop() }}</span>
                            <div class="flex items-center gap-2 flex-shrink-0">
                                <span class="bg-indigo-50 text-indigo-600 px-1 rounded font-mono border border-indigo-100">{{ getFilePreviewTag(file) }}</span>
                                <span class="text-slate-400 font-mono">{{ formatSize(file.size) }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div class="p-3 border-t border-slate-100 bg-white z-20 flex justify-between items-center">
            <div class="text-xs text-slate-500 font-medium">
                已就绪 <span class="font-bold text-indigo-600 text-sm">{{ validItemsCount }}</span> / {{ importQueue.length }}
            </div>
            <button @click="submitAll" :disabled="isBatchSubmitting || validItemsCount === 0" 
                class="px-6 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 text-white rounded-xl font-bold text-xs shadow-md shadow-indigo-200 hover:shadow-lg hover:shadow-indigo-300 active:scale-95 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none">
                <i v-if="isBatchSubmitting" class="fa-solid fa-circle-notch fa-spin"></i>
                <span v-else>全部入库</span>
            </button>
        </div>
    </div>

    <Teleport to="body">
        <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0 scale-95" enter-to-class="opacity-100 scale-100" leave-active-class="transition duration-150 ease-in" leave-from-class="opacity-100 scale-100" leave-to-class="opacity-0 scale-95">
            <div v-if="activeEditItem" class="fixed inset-0 z-[100] flex items-center justify-center p-4">
                <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" @click="closeManualFix"></div>
                <div class="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl flex flex-col max-h-[80vh] overflow-hidden">
                    <div class="flex justify-between items-center p-4 border-b border-slate-100 bg-white">
                        <h3 class="text-sm font-bold text-slate-800">手动匹配修正</h3>
                        <button @click="closeManualFix" class="w-7 h-7 rounded-full bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 flex items-center justify-center transition-colors"><i class="fa-solid fa-times"></i></button>
                    </div>
                    <div class="p-4 bg-slate-50 border-b border-slate-100">
                        <div class="relative flex gap-2">
                            <input type="text" v-model="tmdbSearchQuery" @keyup.enter="searchTmdbManual" class="flex-1 pl-4 pr-4 py-2 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" placeholder="输入剧名、年份或 ID..." autofocus>
                            <button @click="searchTmdbManual" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 shadow-sm transition-colors">搜索</button>
                        </div>
                        <div class="mt-2 text-[10px] text-slate-400 truncate"><span class="font-bold">原文件名:</span> {{ getOriginalName(activeEditItem) }}</div>
                    </div>
                    <div class="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2 bg-white">
                        <div v-if="isSearchingTmdb" class="py-10 text-center text-indigo-500"><i class="fa-solid fa-circle-notch fa-spin text-2xl"></i></div>
                        <div v-else-if="tmdbDropdownList.length > 0">
                            <div v-for="match in tmdbDropdownList" :key="match.id" @click="selectManualMatch(match)" class="flex gap-3 p-2 rounded-xl hover:bg-indigo-50 border border-transparent hover:border-indigo-100 cursor-pointer transition-all group">
                                <div class="w-10 h-14 bg-slate-200 rounded overflow-hidden flex-shrink-0 border border-slate-100">
                                    <img v-if="match.poster_path" :src="`https://image.tmdb.org/t/p/w92${match.poster_path}`" class="w-full h-full object-cover">
                                    <div v-else class="w-full h-full flex items-center justify-center text-slate-400"><i class="fa-solid fa-image"></i></div>
                                </div>
                                <div class="flex-1 min-w-0 flex flex-col justify-center">
                                    <div class="font-bold text-sm text-slate-700 truncate group-hover:text-indigo-700">{{ match.title || match.name }}</div>
                                    <div class="flex gap-2 mt-1 text-[10px]">
                                        <span class="text-slate-500">{{ (match.first_air_date || match.release_date || '未知').split('-')[0] }}</span>
                                        <span class="px-1.5 rounded text-white font-bold" :class="match.media_type === 'movie' ? 'bg-orange-400' : 'bg-blue-400'">{{ match.media_type === 'movie' ? '电影' : '剧集' }}</span>
                                    </div>
                                </div>
                                <div class="flex items-center text-indigo-400 opacity-0 group-hover:opacity-100 px-2"><i class="fa-solid fa-check"></i></div>
                            </div>
                        </div>
                        <div v-else class="py-10 text-center text-slate-400 text-xs">未找到结果，请尝试更换关键词</div>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar { width: 4px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 10px; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #94a3b8; }
</style>