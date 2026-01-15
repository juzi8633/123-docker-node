import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../src/db.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const STRM_ROOT = process.env.STRM_ROOT || path.join(process.cwd(), 'strm_data');

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
        if (e.code !== 'ENOENT') console.error(`[Scan Error] ${dir}: ${e.message}`);
    }
    return results;
}

async function removeEmptyDirectories(directory) {
    try {
        const entries = await fs.readdir(directory);
        if (entries.length > 0) return;
        await fs.rmdir(directory);
    } catch (e) {}
}

// 封装为主函数
export async function runVerifyStrm() {
    console.log('🔍 [Verify] 开始一致性校验...');
    const startTime = Date.now();

    const dbEpisodes = await prisma.seriesEpisode.findMany({ select: { id: true } });
    const validIds = new Set(dbEpisodes.map(e => e.id));
    
    try { await fs.access(STRM_ROOT); } catch { return { success: false, message: "根目录不存在" }; }

    const files = await getAllStrmFiles(STRM_ROOT);
    let deletedCount = 0;
    let errorCount = 0;

    for (const file of files) {
        try {
            const content = await fs.readFile(file, 'utf8');
            const match = content.match(/\/api\/play\/(\d+)/);
            let shouldDelete = false;

            if (!match) shouldDelete = true;
            else if (!validIds.has(parseInt(match[1]))) shouldDelete = true;

            if (shouldDelete) {
                await fs.unlink(file);
                deletedCount++;
                await removeEmptyDirectories(path.dirname(file));
            }
        } catch (e) {
            errorCount++;
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`🎉 校验完成: 扫描 ${files.length}, 删除 ${deletedCount}, 耗时 ${duration}s`);
    
    return { 
        success: true, 
        stats: { total: files.length, deleted: deletedCount, errors: errorCount, duration } 
    };
}

// CLI 模式
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runVerifyStrm()
        .then(() => process.exit(0))
        .catch(e => {
            console.error(e);
            process.exit(1);
        });
}