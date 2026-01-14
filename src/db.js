import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

export const prisma = new PrismaClient();

// === 路径修正逻辑 ===
// 1. 获取 .env 中的路径
let dbPath = process.env.DATABASE_URL.replace('file:', '');

// 2. 解决 Prisma 与 Node 运行时路径不一致的问题
// Prisma 的 ../data 是相对于 prisma/ 目录的 (即项目根目录/data)
// Node 运行时 ../data 是相对于项目根目录的 (即项目上层目录/data -> 这是错的)
if (dbPath.startsWith('../data') || dbPath.startsWith('..\\data')) {
    // 强制修正为当前目录下的 data 文件夹
    dbPath = path.join(process.cwd(), 'data', path.basename(dbPath));
}

// 3. 自动创建 data 目录 (防止目录不存在报错)
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[DB] Created database directory: ${dir}`);
}

// 4. 初始化 SQLite
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');

// === D1 API 适配器 (保持不变) ===
class D1PreparedStatement {
    constructor(stmt, args = []) {
        this.stmt = stmt;
        this.args = args;
    }

    bind(...args) {
        return new D1PreparedStatement(this.stmt, args);
    }

    async first() {
        return this.stmt.get(...this.args);
    }

    async all() {
        const results = this.stmt.all(...this.args);
        return { results };
    }

    async run() {
        const info = this.stmt.run(...this.args);
        return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
    }
}

export const DB = {
    prepare: (sql) => {
        try {
            const stmt = sqlite.prepare(sql);
            return new D1PreparedStatement(stmt);
        } catch (e) {
            console.error("SQL Prepare Error:", e.message);
            throw e;
        }
    },
    
    batch: async (statements) => {
        const runTransaction = sqlite.transaction((stmts) => {
            return stmts.map(s => s.stmt.run(...s.args));
        });
        const results = runTransaction(statements);
        return results.map(info => ({ meta: { changes: info.changes } }));
    }
};