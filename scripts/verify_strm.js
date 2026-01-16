import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../src/db.js';
import { strmService } from '../src/services/strm.js'; // [新增] 引入路径计算逻辑
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

// [新增] 简易日志工具
function log(msg) {
    const time = new Date().toISOString().split('T')[1].split('.')[0];
    const prefix = `[VerifyStrm ${time}]`;
    console.log(`${prefix} ${msg}`);
}

// [修改] 统一默认目录为 'strm'，与 strm.js 保持一致
const STRM_ROOT = process.env.STRM_ROOT || path.join(process.cwd(), 'strm');

async function getAllStrmFiles(dir) {
    let results = [];
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results = results.concat(await getAllStrmFiles(fullPath));
            } else if (entry.name.endsWith('.strm')) {
                results.push(fullPath);
            }
        }
    } catch (e) {
        if (e.code !== 'ENOENT') log(`[Error] 扫描目录失败 ${dir}: ${e.message}`);
    }
    return results;
}

async function removeEmptyDirectories(directory) {
    try {
        // 防止误删根目录
        if (path.resolve(directory) === path.resolve(STRM_ROOT)) return;

        const entries = await fs.readdir(directory);
        if (entries.length > 0) return;
        await fs.rmdir(directory);
        log(`[Cleanup] 🗑️ 移除空目录: ${directory}`);
    } catch (e) {}
}

// 封装为主函数
export async function runVerifyStrm() {
    log('🔍 [Start] 开始一致性校验 (严格路径模式)...');
    const startTime = Date.now();

    // 1. 检查根目录
    log(`[Init] 检查 STRM 根目录: ${STRM_ROOT}`);
    try { await fs.access(STRM_ROOT); } catch { 
        log(`[Error] 根目录不存在，终止校验`);
        return { success: false, message: "根目录不存在" }; 
    }

    // 2. [核心修改] 构建标准路径白名单
    log(`[Init] 正在从数据库计算所有预期路径...`);
    const episodes = await prisma.seriesEpisode.findMany({
        include: { series: true } // 需要 series 信息来计算路径
    });

    const validPaths = new Set();
    for (const ep of episodes) {
        try {
            const { dirPath, fileName } = strmService.calculatePath(ep);
            // 生成绝对路径并标准化 (解决 Windows/Linux 路径分隔符差异)
            const fullPath = path.resolve(STRM_ROOT, dirPath, fileName);
            validPaths.add(fullPath);
        } catch (e) {
            log(`[Warn] 路径计算失败 (ID:${ep.id}): ${e.message}`);
        }
    }
    log(`[Init] 数据库预期文件数: ${validPaths.size} (含视频与字幕)`);

    // 3. 扫描磁盘
    log(`[Scan] 正在遍历磁盘文件...`);
    const files = await getAllStrmFiles(STRM_ROOT);
    log(`[Scan] 磁盘 .strm 文件总数: ${files.length}`);

    let deletedCount = 0;
    let errorCount = 0;

    // 4. [核心修改] 严格比对
    for (const file of files) {
        try {
            // 获取当前文件的绝对路径
            const absolutePath = path.resolve(file);

            // 如果不在白名单里，直接删除
            if (!validPaths.has(absolutePath)) {
                log(`[Delete] 🗑️ 删除冗余文件: ${path.basename(file)} (数据库中无此路径)`);
                await fs.unlink(file);
                deletedCount++;
                await removeEmptyDirectories(path.dirname(file));
            } else {
                // 如果在白名单里，保留 (不做操作)
                // log(`[Keep] √ ${path.basename(file)}`); 
            }
        } catch (e) {
            log(`[Error] 删除文件出错 ${path.basename(file)}: ${e.message}`);
            errorCount++;
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`🎉 校验完成: 扫描 ${files.length}, 删除 ${deletedCount}, 错误 ${errorCount}, 耗时 ${duration}s`);
    
    return { 
        success: true, 
        stats: { total: files.length, deleted: deletedCount, errors: errorCount, duration }
    };
}

// CLI check
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runVerifyStrm().then((res) => {
        process.exit(0);
    }).catch((e) => {
        console.error(e);
        process.exit(1);
    });
}