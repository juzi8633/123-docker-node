<script setup>
import { toastState, removeToast } from '../utils/toast.js'

// 图标映射
const icons = {
    success: 'fa-solid fa-circle-check',
    error: 'fa-solid fa-circle-xmark',
    warning: 'fa-solid fa-triangle-exclamation',
    info: 'fa-solid fa-circle-info'
}

// 颜色映射 (背景色/边框色/文字色)
const styles = {
    success: 'bg-white/90 border-emerald-500 text-emerald-600',
    error: 'bg-white/90 border-red-500 text-red-600',
    warning: 'bg-white/90 border-amber-500 text-amber-600',
    info: 'bg-white/90 border-indigo-500 text-indigo-600'
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed top-20 right-0 sm:right-6 z-[300] flex flex-col items-end gap-3 p-4 pointer-events-none w-full sm:w-auto">
        
        <TransitionGroup name="toast-slide">
            <div v-for="toast in toastState.items" :key="toast.id" 
                 class="pointer-events-auto relative overflow-hidden flex items-center gap-3 px-4 py-3.5 rounded-xl shadow-lg shadow-slate-200/50 backdrop-blur-md border-l-4 min-w-[300px] max-w-sm ring-1 ring-black/5 cursor-pointer transition-all select-none bg-white"
                 :class="[
                     toast.type === 'success' ? 'border-emerald-500' : 
                     toast.type === 'error' ? 'border-red-500' : 
                     toast.type === 'warning' ? 'border-amber-500' : 'border-indigo-500'
                 ]"
                 @click="removeToast(toast.id)">
                
                <div class="flex-shrink-0 text-lg" 
                     :class="[
                        toast.type === 'success' ? 'text-emerald-500' : 
                        toast.type === 'error' ? 'text-red-500' : 
                        toast.type === 'warning' ? 'text-amber-500' : 'text-indigo-500'
                     ]">
                    <i :class="icons[toast.type]"></i>
                </div>

                <div class="flex-1 text-sm font-bold text-slate-700 leading-snug">
                    {{ toast.text }}
                </div>

                <div class="text-slate-300 hover:text-slate-500 transition-colors">
                    <i class="fa-solid fa-xmark text-xs"></i>
                </div>
            </div>
        </TransitionGroup>

    </div>
  </Teleport>
</template>

<style scoped>
/* 列表过渡动画 */
.toast-slide-enter-active,
.toast-slide-leave-active {
  transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.toast-slide-enter-from {
  opacity: 0;
  transform: translateX(30px) scale(0.95);
}

.toast-slide-leave-to {
  opacity: 0;
  transform: translateY(-20px) scale(0.95);
}

/* 移动端优化：从顶部滑入 */
@media (max-width: 640px) {
    .toast-slide-enter-from {
        opacity: 0;
        transform: translateY(-30px);
    }
}
</style>