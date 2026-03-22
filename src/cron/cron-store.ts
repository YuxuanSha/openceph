import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as os from "os"
import * as path from "path"
import type { CronJob, CronRunEntry, CronSystemEvent } from "./cron-types.js"
import { parseDurationMs } from "./time.js"

export class CronStore {
  private runsDir: string
  private eventsPath: string

  constructor(private storePath: string) {
    this.runsDir = path.join(path.dirname(storePath), "runs")
    this.eventsPath = path.join(path.dirname(storePath), "main-session-events.json")
  }

  async loadAll(): Promise<CronJob[]> {
    await this.ensureDirs()
    if (!existsSync(this.storePath)) return []
    const content = await fs.readFile(this.storePath, "utf-8")
    const parsed = JSON.parse(content) as CronJob[]
    return Array.isArray(parsed) ? parsed : []
  }

  async saveAll(jobs: CronJob[]): Promise<void> {
    await this.ensureDirs()
    const tempPath = `${this.storePath}.tmp`
    await fs.writeFile(tempPath, JSON.stringify(jobs, null, 2), "utf-8")
    await fs.rename(tempPath, this.storePath)
  }

  async appendRunEntry(jobId: string, entry: CronRunEntry): Promise<void> {
    await this.ensureDirs()
    const runPath = path.join(this.runsDir, `${jobId}.jsonl`)
    await fs.appendFile(runPath, `${JSON.stringify(entry)}\n`, "utf-8")
  }

  async getRunEntries(jobId: string, limit = 20): Promise<CronRunEntry[]> {
    const runPath = path.join(this.runsDir, `${jobId}.jsonl`)
    if (!existsSync(runPath)) return []
    const content = await fs.readFile(runPath, "utf-8")
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CronRunEntry)
      .slice(-limit)
      .reverse()
  }

  async pruneRunLogs(config: { maxBytes: number; keepLines: number }): Promise<void> {
    await this.ensureDirs()
    const files = await fs.readdir(this.runsDir)
    for (const file of files) {
      const filePath = path.join(this.runsDir, file)
      const stat = await fs.stat(filePath)
      if (stat.size <= config.maxBytes) continue
      const lines = (await fs.readFile(filePath, "utf-8")).split("\n").filter(Boolean)
      const trimmed = lines.slice(-config.keepLines)
      await fs.writeFile(filePath, trimmed.join("\n") + (trimmed.length > 0 ? "\n" : ""), "utf-8")
    }
  }

  async pruneIsolatedSessions(retention: string): Promise<void> {
    const baseDir = path.join(os.homedir(), ".openceph", "agents", "cron", "sessions")
    if (!existsSync(baseDir)) return
    const ttlMs = parseDurationMs(retention)
    const cutoff = Date.now() - ttlMs
    const files = await fs.readdir(baseDir)
    for (const file of files) {
      const filePath = path.join(baseDir, file)
      const stat = await fs.stat(filePath)
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(filePath).catch(() => undefined)
      }
    }
  }

  async appendSystemEvent(event: CronSystemEvent): Promise<void> {
    const events = await this.readSystemEvents()
    events.push(event)
    await fs.writeFile(this.eventsPath, JSON.stringify(events, null, 2), "utf-8")
  }

  async readSystemEvents(): Promise<CronSystemEvent[]> {
    await this.ensureDirs()
    if (!existsSync(this.eventsPath)) return []
    const content = await fs.readFile(this.eventsPath, "utf-8")
    const parsed = JSON.parse(content) as CronSystemEvent[]
    return Array.isArray(parsed) ? parsed : []
  }

  async clearSystemEvents(): Promise<void> {
    await this.ensureDirs()
    await fs.writeFile(this.eventsPath, "[]", "utf-8")
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true })
    await fs.mkdir(this.runsDir, { recursive: true })
  }
}
