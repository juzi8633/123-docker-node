import { reactive } from 'vue'

// 消息队列状态
export const toastState = reactive({
    items: [] // { id, text, type: 'success'|'error'|'info'|'warning' }
})

let idCounter = 0

/**
 * 唤起全局通知
 * @param {string} text - 内容
 * @param {string} type - 类型: 'success' | 'error' | 'warning' | 'info'
 * @param {number} duration - 持续时间 (ms)
 */
export function showToast(text, type = 'success', duration = 3000) {
    const id = idCounter++
    const toast = { id, text, type }
    
    // 添加到队列顶部
    toastState.items.unshift(toast)

    // 自动移除
    if (duration > 0) {
        setTimeout(() => {
            removeToast(id)
        }, duration)
    }
}

export function removeToast(id) {
    const index = toastState.items.findIndex(t => t.id === id)
    if (index !== -1) {
        toastState.items.splice(index, 1)
    }
}