import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../src/db.js';
import { strmService } from '../src/services/strm.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { createLogger } from '../src/logger.js'; // [优化] 引入日志模块

dotenv.config();

// [优化] 初始化模块专用日志
const logger = createLogger('VerifyStrm');

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
        if (e.code !== 'ENOENT') logger.error({ dir, error: e.message }, `[Error] 扫描目录失败`);
    }
    return results;
}

async function removeEmptyDirectories(directory) {
    try {
        // 防止误删根目录
        if (path.resolve(directory) === path.resolve(STRM_ROOT)) return;

        const files = await fs.readdir(directory);

        // [核心修改] 定义会被视为"垃圾"的文件后缀
        // 如果目录里只剩下这些文件，视为可以删除
        const IGNORED_EXTS = ['.nfo', '.jpg', '.jpeg', '.png', '.webp', '.tbn', '.xml', '.bif', '.json'];
        
        // 检查是否存在"有效文件" (即: 不是垃圾文件，且有扩展名；或者是子目录)
        const hasValidFiles = files.some(file => {
            const ext = path.extname(file).toLowerCase();
            // 如果没有后缀(通常是子文件夹) 或者 后缀不在忽略列表中，则视为有效内容 -> 保留目录
            return !ext || !IGNORED_EXTS.includes(ext);
        });

        if (!hasValidFiles) {
            // 如果只剩下垃圾文件，执行强制递归删除
            // fs.rm (Node 14.14+) 支持 recursive 和 force
            await fs.rm(directory, { recursive: true, force: true });
            logger.info({ directory }, `[Cleanup] 🗑️ 移除逻辑空目录 (含元数据)`);
        }
    } catch (e) {
        // 忽略删除目录时的非致命错误 (如目录已不存在)
    }
}

// 封装为主函数
export async function runVerifyStrm() {
    logger.info('🔍 [Start] 开始一致性校验 (严格路径模式)...');
    const startTime = Date.now();

    // 1. 检查根目录
    logger.info({ root: STRM_ROOT }, `[Init] 检查 STRM 根目录`);
    try { await fs.access(STRM_ROOT); } catch { 
        logger.error(`[Error] 根目录不存在，终止校验`);
        return { success: false, message: "根目录不存在" }; 
    }

    // 2. [核心修改] 构建标准路径白名单
    logger.info(`[Init] 正在从数据库计算所有预期路径...`);
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
            logger.warn({ id: ep.id, error: e.message }, `[Warn] 路径计算失败`);
        }
    }
    logger.info({ count: validPaths.size }, `[Init] 数据库预期文件数 (含视频与字幕)`);

    // 3. 扫描磁盘
    logger.info(`[Scan] 正在遍历磁盘文件...`);
    const files = await getAllStrmFiles(STRM_ROOT);
    logger.info({ count: files.length }, `[Scan] 磁盘 .strm 文件总数`);

    let deletedCount = 0;
    let errorCount = 0;

    // 4. [核心修改] 严格比对
    for (const file of files) {
        try {
            // 获取当前文件的绝对路径
            const absolutePath = path.resolve(file);

            // 如果不在白名单里，直接删除
            if (!validPaths.has(absolutePath)) {
                logger.info({ file: path.basename(file) }, `[Delete] 🗑️ 删除冗余文件 (数据库中无此路径)`);
                await fs.unlink(file);
                deletedCount++;
                await removeEmptyDirectories(path.dirname(file));
            } else {
                // 如果在白名单里，保留 (不做操作)
            }
        } catch (e) {
            logger.error({ file: path.basename(file), error: e.message }, `[Error] 删除文件出错`);
            errorCount++;
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info({ total: files.length, deleted: deletedCount, errors: errorCount, duration }, `🎉 校验完成`);
    
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
        // 确保错误被记录（logger.error 已经在函数内部可能未捕获的顶层异常处使用，这里做兜底）
        // 如果 logger 初始化失败，回退到 console
        try { logger.error(e, 'Unhandled Script Error'); } catch { console.error(e); }
        process.exit(1);
    });
}