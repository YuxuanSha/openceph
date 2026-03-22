import * as fs from "fs/promises"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import * as lockfile from "proper-lockfile"
import * as os from "os"
import * as path from "path"

export type CodeAgentReusableStatus = "active" | "reusable" | "consumed" | "invalid"

export interface CodeAgentReusableRunRecord {
  brainSessionKey: string
  tentacleId: string
  claudeSessionId?: string
  workDir: string
  sessionFile: string
  mode: "generate" | "fix" | "merge"
  createdAt: string
  lastUsedAt: string
  status: CodeAgentReusableStatus
  deployed: boolean
  deploySucceeded: boolean
  spawned: boolean
  lastRequirementFingerprint: string
}

interface ReusableRunStoreShape {
  runs: CodeAgentReusableRunRecord[]
}

export class CodeAgentReuseStore {
  private readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".openceph", "agents", "code-agent", "state")
  }

  get storePath(): string {
    return path.join(this.baseDir, "reusable-runs.json")
  }

  async getReusableRun(brainSessionKey: string, tentacleId: string): Promise<CodeAgentReusableRunRecord | null> {
    return this.withLock(async () => {
      const state = this.readStore()
      return state.runs.find((run) =>
        run.brainSessionKey === brainSessionKey
        && run.tentacleId === tentacleId
        && run.status === "reusable"
      ) ?? null
    })
  }

  async upsert(run: CodeAgentReusableRunRecord): Promise<void> {
    await this.withLock(async () => {
      const state = this.readStore()
      const next = state.runs.filter((item) =>
        !(item.brainSessionKey === run.brainSessionKey && item.tentacleId === run.tentacleId)
      )
      next.push(run)
      state.runs = next.sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt))
      this.writeStore(state)
    })
  }

  async update(
    brainSessionKey: string,
    tentacleId: string,
    patch: Partial<CodeAgentReusableRunRecord>,
  ): Promise<CodeAgentReusableRunRecord | null> {
    return this.withLock(async () => {
      const state = this.readStore()
      const index = state.runs.findIndex((run) => run.brainSessionKey === brainSessionKey && run.tentacleId === tentacleId)
      if (index === -1) return null
      state.runs[index] = {
        ...state.runs[index],
        ...patch,
      }
      this.writeStore(state)
      return state.runs[index]
    })
  }

  async invalidate(brainSessionKey: string, tentacleId: string): Promise<void> {
    await this.update(brainSessionKey, tentacleId, {
      status: "invalid",
      lastUsedAt: new Date().toISOString(),
    })
  }

  private ensureDir(): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true })
    }
  }

  private readStore(): ReusableRunStoreShape {
    this.ensureDir()
    try {
      return JSON.parse(readFileSync(this.storePath, "utf-8")) as ReusableRunStoreShape
    } catch {
      return { runs: [] }
    }
  }

  private writeStore(store: ReusableRunStoreShape): void {
    this.ensureDir()
    writeFileSync(this.storePath, JSON.stringify(store, null, 2), "utf-8")
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.ensureDir()
    if (!existsSync(this.storePath)) {
      writeFileSync(this.storePath, JSON.stringify({ runs: [] }, null, 2), "utf-8")
    }
    const release = await lockfile.lock(this.storePath, { retries: { retries: 3, factor: 1.5, minTimeout: 20 } })
    try {
      return await fn()
    } finally {
      await release().catch(async () => {
        await fs.access(this.storePath).catch(() => undefined)
      })
    }
  }
}
