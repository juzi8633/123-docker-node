<script setup>
import { ref, computed, onUnmounted } from 'vue' // 引入 onUnmounted
import { 
  rebuildJsonWithTmdb, 
  autoGroupFiles, 
  formatSize 
} from '../utils/logic.js'
import Toastify from 'toastify-js'

// =========================
// 基础状态
// =========================
const universalInput = ref('')
const detectState = ref({ text: '', style: 'opacity-0 scale-90' })
const showLinkOptions = ref(false)
const panType = ref('123')
const sharePassword = ref('')
const shareUrl = ref('')

// 解析状态
const isParsing = ref(false)
const parseStatusText = ref('处理中...')
const parsePercent = ref(0)
// [优化] 引用 SSE 实例，用于销毁
const eventSourceInstance = ref(null)

// =========================
// 核心：导入队列系统 (Batch System)
// =========================
const importQueue = ref([])        
const isBatchMatching = ref(false) 
const isBatchSubmitting = ref(false) 
const activeEditItem = ref(null)   

// TMDB 搜索相关
const tmdbSearchQuery = ref('')
const tmdbDropdownList = ref([])
const isSearchingTmdb = ref(false)

// ----------------------------------------------------------------
// 1. 输入处理 & 解析流程
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

    let type = ''
    if (/123(pan|865|684|912)\.(com|cn)/.test(val)) type = '123'
    else if (val.includes('189.cn')) type = '189'
    else if (val.includes('quark.cn')) type = 'quark'

    if (type) {
      setDetectState(`${type} 网盘`, 'info')
      const urlMatch = val.match(/https?:\/\/[a-zA-Z0-9\.\/\?\=\-\_]+/)
      const pwdMatch = val.match(/(提取码|密码|访问码)[：:\s]*([a-zA-Z0-9]{4})/)
      
      showLinkOptions.value = true
      panType.value = type
      if (urlMatch) {
        shareUrl.value = urlMatch[0]
        if (type === '123') { try { sharePassword.value = new URL(urlMatch[0]).searchParams.get('pwd') || '' } catch(e){} }
        if (type === '189') { try { sharePassword.value = new URL(urlMatch[0]).searchParams.get('code') || '' } catch(e){} }
      }
      if (pwdMatch && !sharePassword.value) sharePassword.value = pwdMatch[2]
      return
    }
    setDetectState('未知格式', 'error')
  }, 500)
}

const setDetectState = (text, type) => {
  let color = type === 'success' ? 'bg-emerald-100 text-emerald-700' : 
              type === 'info' ? 'bg-indigo-100 text-indigo-700' : 
              'bg-red-100 text-red-700'
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
// 2. 链接解析 (SSE Stream)
// ----------------------------------------------------------------
const startParsing = () => {
  const cookie = localStorage.getItem('quark_cookie')
  if (panType.value === 'quark' && !cookie) {
    Toastify({text: "请设置夸克Cookie", style: {background: "#ef4444"}}).showToast()
    return
  }
  
  isParsing.value = true
  parsePercent.value = 0
  
  // [优化] 防抖：关闭旧连接
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
  eventSourceInstance.value = es // 保存引用

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
      Toastify({text: msg.data.message, style: {background: "#ef4444"}}).showToast()
    }
  }
  
  es.onerror = () => { 
      es.close(); 
      eventSourceInstance.value = null;
      isParsing.value = false; 
  }
}

// [优化] 组件卸载时强制断开连接
onUnmounted(() => {
    if (eventSourceInstance.value) {
        eventSourceInstance.value.close()
        eventSourceInstance.value = null
    }
})

// ----------------------------------------------------------------
// 3. [核心] 队列与匹配逻辑
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
    tmdbId: g.tmdbId, // [新增] 获取逻辑层提取的 ID
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
  const apiKey = localStorage.getItem('tmdb_key')
  
  if (!apiKey) {
    Toastify({text: "未配置 TMDB Key，请手动搜索", style: {background: "#f59e0b"}}).showToast()
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

// [优化] 匹配逻辑增强：支持 ±1 年误差
const findBestMatch = (results, targetYear) => {
  if (!results || results.length === 0) return null;
  if (!targetYear) return results[0];

  const target = parseInt(targetYear);

  // 1. 精确匹配
  const exactMatch = results.find(res => getResultYear(res) === target);
  if (exactMatch) return exactMatch;

  // 2. 模糊匹配 (±1 年)
  const fuzzyMatch = results.find(res => Math.abs(getResultYear(res) - target) <= 1);
  if (fuzzyMatch) return fuzzyMatch;

  return null; 
}

// ==========================================
// 主逻辑
// ==========================================
const autoMatchSingleItem = async (item, apiKey) => {
  item.status = 'loading'
  
  // [修正] 显式定义 type 和 ID
  const type = item.isTV ? 'tv' : 'movie'
  const directId = item.tmdbId
  
  try {
    let bestMatch = null
    
    // [新增] 优先尝试 ID 精确匹配
    if (directId) {
        // TMDB 详情接口返回对象，不是数组
        const url = `https://api.themoviedb.org/3/${type}/${directId}?api_key=${apiKey}&language=zh-CN`
        const res = await fetch(url)
        if (res.ok) {
            bestMatch = await res.json()
            // 详情接口不返回 media_type，手动补全，供后续逻辑判断
            bestMatch.media_type = type 
            // 详情接口返回的是 genres 对象数组 [{id,name},...], 需要转为 genre_ids 数组供后续使用
            bestMatch.genre_ids = bestMatch.genres.map(({id})=>id);
        }
    }

    // [原有逻辑] 如果 ID 匹配失败或无 ID，回退到搜索
    if (!bestMatch) {
        const q = encodeURIComponent(item.searchQuery)
        const targetYear = item.year 
        
        const yearParam = targetYear ? `&${type === 'movie' ? 'primary_release_year' : 'first_air_date_year'}=${targetYear}` : ''
        let url = `https://api.themoviedb.org/3/search/${type}?api_key=${apiKey}&query=${q}&language=zh-CN${yearParam}`
        
        let res = await fetch(url)
        let data = await res.json()
        let candidates = data.results || []
        
        bestMatch = findBestMatch(candidates, targetYear)

        // 二次尝试：去除年份参数
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
       // 如果搜索也没结果，且之前尝试过 ID 匹配，说明 ID 可能是错的或者文件解析有问题
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
  
  // =========================================================
  // [修复核心] 提取语言和国家，用于后端 Strm 分类
  // =========================================================
  const originalLanguage = tmdbData.original_language || '';
  
  // 国家处理较为复杂，因为 TMDB 在不同接口返回结构不同
  let originCountry = '';
  
  if (tmdbData.origin_country && Array.isArray(tmdbData.origin_country)) {
      // TV 剧集通常有 origin_country 数组 (e.g. ['CN'])
      originCountry = tmdbData.origin_country.join(',');
  } else if (tmdbData.production_countries && Array.isArray(tmdbData.production_countries)) {
      // 电影详情接口返回 production_countries 数组对象 (e.g. [{iso_3166_1: 'CN', name: 'China'}])
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
    // [新增] 保存语言和国家信息
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
// 4. 手动修正逻辑 (Modal)
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
  const apiKey = localStorage.getItem('tmdb_key')
  
  try {
    const q = encodeURIComponent(tmdbSearchQuery.value)
    const res = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${apiKey}&query=${q}&language=zh-CN`)
    const data = await res.json()
    tmdbDropdownList.value = (data.results || []).filter(i => i.media_type !== 'person')
  } catch(e) {
    Toastify({text: "搜索失败，请检查网络", style: {background: "#ef4444"}}).showToast()
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
// 5. 批量提交逻辑
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
        // [新增] 提交语言和国家给后端
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
  
  Toastify({
    text: `批量处理完成: 成功 ${successCount} / 总计 ${itemsToSubmit.length}`, 
    duration: 3000,
    style: {background: successCount === itemsToSubmit.length ? "#10b981" : "#f59e0b"}
  }).showToast()
  
  if (successCount === itemsToSubmit.length) {
      setTimeout(() => {
          // clearInput() 
      }, 2000)
  }
}

const toggleIgnore = (item) => {
  if (item.status === 'ignored') {
    item.status = 'pending'
    const apiKey = localStorage.getItem('tmdb_key')
    autoMatchSingleItem(item, apiKey)
  } else {
    item.status = 'ignored'
  }
}
</script>

<template>
  <div class="h-full flex flex-col gap-6 pl-2 relative">
    <div class="relative group pl-6 border-l-2 border-slate-200 hover:border-indigo-200 transition-colors">
       <div class="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-white border-2 border-slate-200 group-hover:border-indigo-400 group-hover:scale-110 transition-all z-10"></div>
       <div class="flex justify-between items-center mb-3">
        <span class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">Step 1: 资源录入</span>
        <button v-if="importQueue.length > 0" @click="clearInput" class="text-[10px] text-red-400 hover:text-red-600 bg-red-50 px-2 py-1 rounded transition-colors">清空重置</button>
      </div>
      <div class="relative">
        <textarea v-model="universalInput" @input="handleInput" :disabled="importQueue.length > 0"
          class="w-full h-24 p-4 bg-white border border-slate-200 rounded-2xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none font-mono text-xs text-slate-600 resize-none transition-all shadow-sm hover:shadow-md disabled:bg-slate-50 disabled:text-slate-400" 
          placeholder="在此粘贴分享链接 (123/夸克/189) 或 RapidTransfer JSON..."></textarea>
        <div class="absolute bottom-3 right-3 px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-300 transform shadow-sm flex items-center gap-1.5" :class="detectState.style">{{ detectState.text }}</div>
      </div>
      <Transition enter-active-class="transition ease-out duration-300" enter-from-class="opacity-0 -translate-y-2" enter-to-class="opacity-100 translate-y-0">
        <div v-if="showLinkOptions" class="mt-4 p-4 bg-indigo-50/50 rounded-2xl border border-indigo-100 flex items-center gap-4">
            <div class="flex-1 grid grid-cols-2 gap-4">
                <input type="text" v-model="sharePassword" class="px-3 py-2 rounded-xl border border-indigo-100 text-xs outline-none focus:border-indigo-400" placeholder="提取码 (自动识别)">
                <button @click="startParsing" :disabled="isParsing" class="bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2">
                    <i v-if="isParsing" class="fa-solid fa-circle-notch fa-spin"></i>{{ isParsing ? `${parsePercent}%` : '开始解析' }}
                </button>
            </div>
        </div>
      </Transition>
    </div>

    <div v-if="importQueue.length > 0" class="flex-1 flex flex-col min-h-0 pl-6 border-l-2 border-slate-200 relative animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div class="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-white border-2 border-slate-200 z-10"></div>
        <div class="flex justify-between items-center mb-3 flex-shrink-0">
          <span class="text-xs font-bold text-slate-500 uppercase tracking-wider">Step 2: 待入库列表 ({{ importQueue.length }})</span>
          <span v-if="isBatchMatching" class="text-[10px] text-indigo-500 flex items-center gap-2 bg-indigo-50 px-2 py-1 rounded-full"><i class="fa-solid fa-circle-notch fa-spin"></i> 正在智能匹配 TMDB...</span>
        </div>
        <div class="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-3 pb-4">
            <div v-for="(item, idx) in importQueue" :key="item.id" class="bg-white border rounded-2xl shadow-sm hover:shadow-md transition-all group relative overflow-hidden"
                 :class="[item.status === 'ignored' ? 'border-slate-100 opacity-60 bg-slate-50' : item.status === 'done' ? 'border-emerald-200 bg-emerald-50/30' : item.status === 'failed' ? 'border-red-200 bg-red-50/20' : 'border-slate-200']">
                <div class="p-3 flex gap-4 items-start relative z-10">
                    <div class="w-12 h-16 rounded-lg bg-slate-100 flex-shrink-0 overflow-hidden relative border border-slate-200 flex items-center justify-center">
                        <img v-if="item.tmdbInfo && item.tmdbInfo.poster" :src="`https://image.tmdb.org/t/p/w92${item.tmdbInfo.poster}`" class="w-full h-full object-cover">
                        <div v-else-if="item.status === 'loading'" class="text-indigo-400"><i class="fa-solid fa-circle-notch fa-spin"></i></div>
                        <div v-else-if="item.status === 'failed'" class="text-red-400 font-bold text-xs"><i class="fa-solid fa-question"></i></div>
                        <div v-else class="text-slate-300 font-bold text-xs">{{ item.searchQuery.substr(0,1).toUpperCase() }}</div>
                        <div v-if="item.status === 'done'" class="absolute inset-0 bg-emerald-500/80 flex items-center justify-center text-white text-xl"><i class="fa-solid fa-check"></i></div>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="flex justify-between items-start">
                            <div class="min-w-0">
                                <h3 class="text-sm font-bold truncate pr-2" :class="item.status === 'failed' ? 'text-red-600' : 'text-slate-700'" :title="item.searchQuery">
                                    {{ item.status === 'matched' || item.status === 'done' ? item.tmdbInfo.name : item.searchQuery }}
                                </h3>
                                <div class="text-[10px] text-slate-400 truncate mt-1 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100 inline-block max-w-full">📄 原始: {{ getOriginalName(item) }}</div>
                                <div class="text-[10px] text-slate-400 font-mono mt-1 flex items-center gap-2">
                                    <span v-if="item.year" class="bg-slate-100 px-1.5 rounded">{{ item.year }}</span>
                                    <span v-if="item.isTV" class="bg-blue-50 text-blue-500 px-1.5 rounded">TV</span>
                                    <span>{{ item.files.length }} 个文件</span>
                                </div>
                            </div>
                            <div class="flex items-center gap-1">
                                <button @click="toggleExpand(item)" class="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 rounded-lg transition-all" title="查看文件列表"><i class="fa-solid fa-chevron-down transition-transform duration-300" :class="{'rotate-180': item.expanded}"></i></button>
                                <div class="flex gap-1 transition-opacity" :class="item.status==='failed'?'opacity-100':'opacity-0 group-hover:opacity-100'">
                                    <button @click="openManualFix(item)" v-if="item.status !== 'done'" class="px-2 py-1 rounded-lg text-xs font-bold transition-colors flex items-center gap-1" :class="item.status === 'failed' ? 'bg-red-100 text-red-600 hover:bg-red-200' : 'bg-slate-100 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600'"><i class="fa-solid fa-search"></i></button>
                                    <button @click="toggleIgnore(item)" v-if="item.status !== 'done'" class="p-1.5 hover:bg-slate-100 text-slate-400 hover:text-slate-600 rounded-lg transition-colors" :title="item.status==='ignored'?'恢复':'忽略'"><i :class="item.status==='ignored' ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'"></i></button>
                                </div>
                            </div>
                        </div>
                        <div class="mt-2 text-[10px]">
                            <div v-if="item.status === 'loading'" class="text-indigo-400 animate-pulse">正在搜索元数据...</div>
                            <div v-else-if="item.status === 'failed'" class="text-red-500 flex items-center gap-1"><i class="fa-solid fa-circle-exclamation"></i><span>未找到匹配: {{ item.errorMsg || '请尝试手动搜索' }}</span></div>
                            <div v-else-if="item.status === 'matched'" class="text-emerald-600 flex items-center gap-1"><i class="fa-solid fa-link text-[9px]"></i> 已锁定: TMDB {{ item.tmdbInfo.id }}</div>
                            <div v-else-if="item.status === 'ignored'" class="text-slate-400">已忽略此项</div>
                        </div>
                    </div>
                </div>
                <div v-if="item.expanded" class="bg-slate-50 border-t border-slate-100 p-3 mt-0 text-[10px] animate-in slide-in-from-top-2 duration-200">
                    <div class="font-bold text-slate-400 mb-2 flex justify-between px-1"><span>包含文件 ({{ item.files.length }})</span><span>解析预览</span></div>
                    <div class="max-h-40 overflow-y-auto custom-scrollbar space-y-1">
                        <div v-for="(file, fIdx) in item.files" :key="fIdx" class="flex justify-between items-center p-1.5 rounded hover:bg-slate-100 border border-transparent hover:border-slate-200 transition-colors">
                            <span class="truncate w-2/3 text-slate-600" :title="file.path.split('/').pop()">{{ file.path.split('/').pop() }}</span>
                            <div class="flex items-center gap-2 flex-shrink-0">
                                <span class="bg-indigo-100 text-indigo-600 px-1.5 rounded font-mono">{{ getFilePreviewTag(file) }}</span>
                                <span class="text-slate-400 w-12 text-right">{{ formatSize(file.size) }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div class="mt-4 pt-4 border-t border-slate-100 flex justify-between items-center bg-white/50 backdrop-blur-sm">
            <div class="text-xs text-slate-500"><span class="font-bold text-indigo-600">{{ validItemsCount }}</span> 个准备就绪</div>
            <button @click="submitAll" :disabled="isBatchSubmitting || validItemsCount === 0" class="px-6 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white rounded-xl font-bold text-xs shadow-lg shadow-indigo-200 hover:shadow-indigo-300 active:scale-95 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                <i v-if="isBatchSubmitting" class="fa-solid fa-circle-notch fa-spin"></i><span v-else>确认全部入库</span>
            </button>
        </div>
    </div>

    <Teleport to="body">
        <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0">
            <div v-if="activeEditItem" class="fixed inset-0 z-[9999] flex items-center justify-center p-4">
                <div class="absolute inset-0 bg-slate-900/30 backdrop-blur-sm transition-opacity" @click="closeManualFix"></div>
                <div class="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden transform transition-all scale-100 border border-slate-100">
                    <div class="flex justify-between items-center p-5 border-b border-slate-100 bg-white z-10">
                        <h3 class="text-base font-bold text-slate-800">手动搜索匹配</h3>
                        <button @click="closeManualFix" class="w-8 h-8 rounded-full bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600 flex items-center justify-center transition-colors"><i class="fa-solid fa-times"></i></button>
                    </div>
                    <div class="p-5 pb-2 bg-white z-10">
                        <div class="mb-3 text-[10px] text-slate-500 bg-slate-50 p-2.5 rounded-xl border border-slate-100 break-all leading-relaxed"><span class="font-bold text-slate-400 block mb-1">参考文件路径:</span>{{ activeEditItem.files[0].path }}</div>
                        <div class="relative group/search">
                            <i class="fa-solid fa-search absolute left-3.5 top-3 text-slate-400"></i>
                            <input type="text" v-model="tmdbSearchQuery" @keyup.enter="searchTmdbManual" class="w-full pl-10 pr-20 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 transition-all placeholder:text-slate-400" placeholder="输入剧名、年份或 ID..." autofocus>
                            <button @click="searchTmdbManual" class="absolute right-1.5 top-1.5 px-3 py-1.5 bg-indigo-600 text-white border border-indigo-600 rounded-lg text-xs font-bold hover:bg-indigo-700 shadow-sm transition-all active:scale-95">搜索</button>
                        </div>
                    </div>
                    <div class="flex-1 overflow-y-auto custom-scrollbar p-5 pt-2 space-y-2">
                        <div v-if="isSearchingTmdb" class="flex flex-col items-center justify-center py-10 text-indigo-500 gap-2"><i class="fa-solid fa-circle-notch fa-spin text-2xl"></i><span class="text-xs font-medium">正在连接 TMDB...</span></div>
                        <div v-else-if="tmdbDropdownList.length > 0">
                            <div v-for="match in tmdbDropdownList" :key="match.id" @click="selectManualMatch(match)" class="flex gap-4 p-3 rounded-xl hover:bg-indigo-50 cursor-pointer transition-all border border-transparent hover:border-indigo-100 group/item">
                                <div class="w-12 h-16 bg-slate-200 rounded-lg overflow-hidden flex-shrink-0 shadow-sm border border-slate-100"><img v-if="match.poster_path" :src="`https://image.tmdb.org/t/p/w92${match.poster_path}`" class="w-full h-full object-cover"><div v-else class="w-full h-full flex items-center justify-center text-slate-400 bg-slate-100"><i class="fa-solid fa-image"></i></div></div>
                                <div class="flex-1 min-w-0 flex flex-col justify-center">
                                    <div class="font-bold text-sm text-slate-700 truncate group-hover/item:text-indigo-700 transition-colors">{{ match.title || match.name }}</div>
                                    <div class="flex items-center gap-2 mt-1"><span class="text-[10px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">{{ (match.first_air_date || match.release_date || '未知').split('-')[0] }}</span><span class="text-[10px] font-bold text-white px-1.5 py-0.5 rounded uppercase" :class="match.media_type === 'movie' ? 'bg-orange-400' : 'bg-blue-400'">{{ match.media_type === 'movie' ? '电影' : '剧集' }}</span></div>
                                    <div class="text-[10px] text-slate-400 mt-1 line-clamp-1">{{ match.overview || '暂无简介' }}</div>
                                </div>
                                <div class="flex items-center justify-center opacity-0 group-hover/item:opacity-100 -translate-x-2 group-hover/item:translate-x-0 transition-all duration-300"><i class="fa-solid fa-chevron-right text-indigo-400"></i></div>
                            </div>
                        </div>
                        <div v-else class="flex flex-col items-center justify-center py-12 text-slate-400 gap-3"><div class="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center text-xl"><i class="fa-solid fa-wind"></i></div><span class="text-xs">未找到相关结果，换个词试试？</span></div>
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
</style>