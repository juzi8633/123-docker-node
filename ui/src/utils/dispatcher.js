/**
 * src/utils/dispatcher.js
 * 负责将任务打包发送给 Durable Object 后台
 */
import Toastify from 'toastify-js'

/**
 * 启动后台处理流水线
 * @param {Array} selectedFiles - 包含文件信息的数组 {id, clean_name, etag, size, url, ...}
 */
export async function dispatchToBackground(selectedFiles) {
    if (!selectedFiles || selectedFiles.length === 0) return false;

    // 1. 组装任务 Payload
    const tasks = selectedFiles.map(f => ({
        id: f.id,
        name: f.clean_name,
        etag: f.etag,
        size: f.size,
        url: f.url || '', // 泛用字段，保留以支持其他可能的 URL 导入
        source_type: f.source_type, // '189', 'quark'
        source_ref: f.source_ref    // 'fileId|shareId'
    }));

    // [修改] 不再从前端收集凭证，后端 Worker 会自动从数据库读取配置
    // const authConfig = { ... } <- 已移除

    try {
        // 2. 发送给后端 API
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
            Toastify({
                text: `🚀 已提交 ${tasks.length} 个任务到后台处理`,
                duration: 5000,
                gravity: "top", 
                position: "center",
                style: { background: "#10b981" }
            }).showToast();
            return true;
        } else {
            throw new Error(data.message || '提交失败');
        }
    } catch (e) {
        console.error(e);
        Toastify({
            text: `❌ 任务提交出错: ${e.message}`,
            duration: 5000,
            gravity: "top", 
            position: "center",
            style: { background: "#ef4444" }
        }).showToast();
        return false;
    }
}