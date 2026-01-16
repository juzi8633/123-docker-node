import { reactive } from 'vue'

// 全局弹窗状态
export const dialogState = reactive({
    isOpen: false,
    title: '',
    htmlContent: '', // 支持 HTML (用于显示红色警告字)
    type: 'info',    // 'info', 'warning', 'danger'
    confirmText: '确认',
    cancelText: '取消',
    resolve: null,   // Promise 的 resolve 函数
})

/**
 * 唤起全局确认弹窗
 * @param {Object} options
 * @param {string} options.title - 标题
 * @param {string} options.text - 内容 (支持简单HTML)
 * @param {string} options.type - 类型: 'warning' | 'danger' | 'info'
 * @param {string} options.confirmText - 确认按钮文字
 * @param {string} options.cancelText - 取消按钮文字
 * @returns {Promise<boolean>} - 点击确认返回 true，点击取消/关闭返回 false
 */
export function showConfirm({ title, text, type = 'warning', confirmText = '确认', cancelText = '取消' }) {
    return new Promise((resolve) => {
        dialogState.title = title
        dialogState.htmlContent = text
        dialogState.type = type
        dialogState.confirmText = confirmText
        dialogState.cancelText = cancelText
        dialogState.isOpen = true
        dialogState.resolve = resolve
    })
}

// 内部使用：关闭并返回结果
export function closeDialog(result) {
    dialogState.isOpen = false
    if (dialogState.resolve) {
        dialogState.resolve(result)
        dialogState.resolve = null
    }
}