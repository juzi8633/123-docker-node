<script setup>
import { dialogState, closeDialog } from '../utils/dialog.js'

const handleConfirm = () => closeDialog(true)
const handleCancel = () => closeDialog(false)
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="dialogState.isOpen" class="fixed inset-0 z-[200] flex items-center justify-center p-4">
        
        <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" @click="handleCancel"></div>

        <div class="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl shadow-slate-900/20 overflow-hidden animate-scale-in ring-1 ring-white/60">
            
            <div class="h-1.5 w-full" 
                :class="{
                    'bg-indigo-500': dialogState.type === 'info',
                    'bg-amber-500': dialogState.type === 'warning',
                    'bg-red-500': dialogState.type === 'danger'
                }">
            </div>

            <div class="p-6 text-center">
                <div class="mx-auto flex items-center justify-center w-12 h-12 rounded-full mb-4 shadow-sm"
                    :class="{
                        'bg-indigo-50 text-indigo-500': dialogState.type === 'info',
                        'bg-amber-50 text-amber-500': dialogState.type === 'warning',
                        'bg-red-50 text-red-500': dialogState.type === 'danger'
                    }">
                    <i v-if="dialogState.type === 'danger'" class="fa-solid fa-triangle-exclamation text-xl"></i>
                    <i v-else-if="dialogState.type === 'warning'" class="fa-solid fa-circle-exclamation text-xl"></i>
                    <i v-else class="fa-solid fa-circle-info text-xl"></i>
                </div>

                <h3 class="text-lg font-bold text-slate-800 mb-2">{{ dialogState.title }}</h3>
                <div class="text-sm text-slate-500 leading-relaxed" v-html="dialogState.htmlContent"></div>
            </div>

            <div class="flex border-t border-slate-100 bg-slate-50/50">
                <button @click="handleCancel" 
                    class="flex-1 px-4 py-3.5 text-sm font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors focus:outline-none">
                    {{ dialogState.cancelText }}
                </button>
                <div class="w-px bg-slate-200"></div>
                <button @click="handleConfirm" 
                    class="flex-1 px-4 py-3.5 text-sm font-bold transition-colors focus:outline-none"
                    :class="{
                        'text-indigo-600 hover:bg-indigo-50': dialogState.type === 'info',
                        'text-amber-600 hover:bg-amber-50': dialogState.type === 'warning',
                        'text-red-600 hover:bg-red-50': dialogState.type === 'danger'
                    }">
                    {{ dialogState.confirmText }}
                </button>
            </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.animate-scale-in {
    animation: scaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes scaleIn {
    from { opacity: 0; transform: scale(0.95) translateY(10px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
}
</style>