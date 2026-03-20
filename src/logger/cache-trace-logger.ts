import * as fs from "fs/promises"
import { mkdirSync, existsSync } from "fs"
import * as path from "path"

export interface CacheTraceEntry {
  session_id: string
  model: string
  cache_read_tokens: number
  cache_write_tokens: number
  input_tokens: number
  output_tokens: number
}

let traceFilePath: string | null = null

export function initCacheTraceLogger(logDir: string): void {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }
  traceFilePath = path.join(logDir, "cache-trace.jsonl")
}

export async function writeCacheTrace(entry: CacheTraceEntry): Promise<void> {
  if (!traceFilePath) {
    throw new Error("Cache trace logger not initialized. Call initCacheTraceLogger() first.")
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry,
  }) + "\n"

  await fs.appendFile(traceFilePath, line, "utf-8")
}
