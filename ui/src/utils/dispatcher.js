/**
 * src/utils/dispatcher.js
 * 负责将任务打包发送给 Durable Object 后台
 */
import { showToast } from './toast.js'

/**
 * 启动后台处理流水线
 * @param {Array} selectedFiles - 包含任务行数据的数组，优先使用 camelCase 字段（兼容旧 snake_case）
 */
export async function dispatchToBackground(selectedFiles) {
    if (!selectedFiles || selectedFiles.length === 0) return false;

    const tasks = selectedFiles.map(f => ({
        id: f.id,
        cleanName: f.cleanName || f.clean_name || '',
        etag: f.etag,
        size: f.size,
        url: f.url || '', // 泛用字段，保留以支持其他可能的 URL 导入
        sourceType: f.sourceType || f.source_type || '',
        sourceRef: f.sourceRef || f.source_ref || ''
    }));

    // [修改] 不再从前端收集凭证，后端 Worker 会自动从数据库读取配置
    // const authConfig = { ... } <- 已移除

    try {
        const res = await fetch('/api/do/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'ADD_TASKS',
                tasks: tasks
                // [修改] 移除了 auth 字段
            })
        });

        const data = await res.json();

        if (data.success) {
            showToast(`🚀 已提交 ${tasks.length} 个任务到后台处理`, "success")
            return true;
        } else {
            throw new Error(data.message || '提交失败');
        }
    } catch (e) {
        console.error(e);
        showToast(`❌ 任务提交出错: ${e.message}`, "error")
        return false;
    }
}