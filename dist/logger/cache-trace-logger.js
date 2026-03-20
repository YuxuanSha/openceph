import * as fs from "fs/promises";
import { mkdirSync, existsSync } from "fs";
import * as path from "path";
let traceFilePath = null;
export function initCacheTraceLogger(logDir) {
    if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
    }
    traceFilePath = path.join(logDir, "cache-trace.jsonl");
}
export async function writeCacheTrace(entry) {
    if (!traceFilePath) {
        throw new Error("Cache trace logger not initialized. Call initCacheTraceLogger() first.");
    }
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
    }) + "\n";
    await fs.appendFile(traceFilePath, line, "utf-8");
}
