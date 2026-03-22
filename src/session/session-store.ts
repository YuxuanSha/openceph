import { v4 as uuidv4 } from "uuid"
import * as lockfile from "proper-lockfile"
import * as fs from "fs/promises"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import * as path from "path"
import * as os from "os"

export interface SessionEntry {
  sessionId: string
  sessionKey: string
  createdAt: string
  updatedAt: string
  model?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  origin?: { channel?: string; senderId?: string }
}

type SessionStore = Record<string, SessionEntry>

export class SessionStoreManager {
  private baseDir: string

  constructor(private agentId: string) {
    this.baseDir = path.join(os.homedir(), ".openceph", "agents", agentId, "sessions")
  }

  get storePath(): string {
    return path.join(this.baseDir, "sessions.json")
  }

  getTranscriptPath(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.jsonl`)
  }

  async getOrCreate(
    sessionKey: string,
    meta?: Partial<Pick<SessionEntry, "model" | "origin">>,
  ): Promise<SessionEntry> {
    return this.withLock(async () => {
      const store = this.readStore()

      if (store[sessionKey]) {
        return store[sessionKey]
      }

      const now = new Date().toISOString()
      const entry: SessionEntry = {
        sessionId: uuidv4(),
        sessionKey,
        createdAt: now,
        updatedAt: now,
        model: meta?.model,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        origin: meta?.origin,
      }

      store[sessionKey] = entry
      this.writeStore(store)
      return entry
    })
  }

  async updateTokens(
    sessionKey: string,
    delta: { input: number; output: number },
  ): Promise<void> {
    return this.withLock(async () => {
      const store = this.readStore()
      const entry = store[sessionKey]
      if (!entry) return

      entry.inputTokens += delta.input
      entry.outputTokens += delta.output
      entry.totalTokens = entry.inputTokens + entry.outputTokens
      entry.updatedAt = new Date().toISOString()

      this.writeStore(store)
    })
  }

  async reset(
    sessionKey: string,
    reason: "manual" | "daily" | "idle",
  ): Promise<SessionEntry> {
    return this.withLock(async () => {
      const store = this.readStore()
      const existing = store[sessionKey]

      // Archive old JSONL if it exists
      if (existing) {
        const oldPath = this.getTranscriptPath(existing.sessionId)
        if (existsSync(oldPath)) {
          const archiveName = `${existing.sessionId}.jsonl.reset.${new Date().toISOString().replace(/:/g, "-")}`
          const archivePath = path.join(this.baseDir, archiveName)
          await fs.rename(oldPath, archivePath)
        }
      }

      // Create new session entry
      const now = new Date().toISOString()
      const entry: SessionEntry = {
        sessionId: uuidv4(),
        sessionKey,
        createdAt: now,
        updatedAt: now,
        model: existing?.model,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        origin: existing?.origin,
      }

      store[sessionKey] = entry
      this.writeStore(store)
      return entry
    })
  }

  async list(filter?: { activeWithinMinutes?: number }): Promise<SessionEntry[]> {
    const store = this.readStore()
    let entries = Object.values(store)

    if (filter?.activeWithinMinutes) {
      const cutoff = Date.now() - filter.activeWithinMinutes * 60 * 1000
      entries = entries.filter(
        (e) => new Date(e.updatedAt).getTime() > cutoff,
      )
    }

    return entries
  }

  async appendAssistantMessage(
    targetSessionKey: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const entry = await this.getOrCreate(targetSessionKey)
    const transcriptPath = this.getTranscriptPath(entry.sessionId)

    await this.withLock(async () => {
      const message: Record<string, unknown> = {
        role: "assistant",
        content,
        timestamp: new Date().toISOString(),
      }
      if (metadata && Object.keys(metadata).length > 0) {
        message.metadata = metadata
      }

      await fs.appendFile(transcriptPath, `${JSON.stringify(message)}\n`, "utf-8")

      const store = this.readStore()
      const target = store[targetSessionKey]
      if (target) {
        target.updatedAt = new Date().toISOString()
        this.writeStore(store)
      }
    })
  }

  async resolveSessionKeyByTranscriptPath(transcriptPath: string): Promise<string | undefined> {
    const normalizedTarget = path.resolve(transcriptPath)
    const store = this.readStore()

    for (const entry of Object.values(store)) {
      if (path.resolve(this.getTranscriptPath(entry.sessionId)) === normalizedTarget) {
        return entry.sessionKey
      }
    }

    return undefined
  }

  async cleanup(cleanupConfig: {
    maxArchiveFilesPerKey: number
    archiveTtlDays: number
  }): Promise<{ deletedFiles: number; freedBytes: number }> {
    let deletedFiles = 0
    let freedBytes = 0

    let files: string[]
    try {
      files = await fs.readdir(this.baseDir)
    } catch {
      return { deletedFiles, freedBytes }
    }

    // Find archive files grouped by original session
    const archiveFiles = files
      .filter((f) => f.includes(".jsonl.reset."))
      .sort()

    // Delete archives that exceed TTL
    const ttlCutoff = Date.now() - cleanupConfig.archiveTtlDays * 24 * 60 * 60 * 1000
    for (const file of archiveFiles) {
      const filePath = path.join(this.baseDir, file)
      try {
        const stat = await fs.stat(filePath)
        if (stat.mtimeMs < ttlCutoff) {
          await fs.unlink(filePath)
          deletedFiles++
          freedBytes += stat.size
        }
      } catch {
        // Ignore errors on individual files
      }
    }

    // Group remaining archives and enforce max per key
    const store = this.readStore()
    for (const entry of Object.values(store)) {
      const keyArchives = archiveFiles
        .filter((f) => {
          // Check if still exists (may have been deleted above)
          return existsSync(path.join(this.baseDir, f))
        })
        .sort()

      if (keyArchives.length > cleanupConfig.maxArchiveFilesPerKey) {
        const toDelete = keyArchives.slice(
          0,
          keyArchives.length - cleanupConfig.maxArchiveFilesPerKey,
        )
        for (const file of toDelete) {
          const filePath = path.join(this.baseDir, file)
          try {
            const stat = await fs.stat(filePath)
            await fs.unlink(filePath)
            deletedFiles++
            freedBytes += stat.size
          } catch {
            // Ignore
          }
        }
      }
    }

    return { deletedFiles, freedBytes }
  }

  private readStore(): SessionStore {
    this.ensureDir()
    try {
      const data = readFileSync(this.storePath, "utf-8")
      return JSON.parse(data)
    } catch {
      return {}
    }
  }

  private writeStore(store: SessionStore): void {
    this.ensureDir()
    writeFileSync(this.storePath, JSON.stringify(store, null, 2), "utf-8")
  }

  private ensureDir(): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true })
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.ensureDir()

    // Create lockfile target (the sessions dir itself)
    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(this.baseDir, {
        retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
        stale: 10000,
      })
      return await fn()
    } finally {
      if (release) {
        await release()
      }
    }
  }
}
