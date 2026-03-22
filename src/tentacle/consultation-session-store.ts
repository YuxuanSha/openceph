import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import type { ConsultationMode } from "./contract.js"

export interface ConsultationSessionRecord {
  sessionId: string
  tentacleId: string
  mode: ConsultationMode
  status: "open" | "waiting_user" | "waiting_tentacle" | "resolved" | "closed"
  requestIds: string[]
  turn: number
  actionType?: string
  actionDescription?: string
  actionContent?: string
  recentPushMessageId?: string
  recentPushItemIds?: string[]
  lastUserFeedback?: string
  lastUserFeedbackAt?: string
  lastTentacleReplyAt?: string
  createdAt: string
  updatedAt: string
}

interface ConsultationStateFile {
  sessions: ConsultationSessionRecord[]
}

export class ConsultationSessionStore {
  constructor(private readonly statePath: string) {}

  async list(): Promise<ConsultationSessionRecord[]> {
    return (await this.read()).sessions
  }

  async get(sessionId: string): Promise<ConsultationSessionRecord | null> {
    return (await this.read()).sessions.find((session) => session.sessionId === sessionId) ?? null
  }

  async upsert(session: ConsultationSessionRecord): Promise<ConsultationSessionRecord> {
    const state = await this.read()
    const next = {
      ...session,
      updatedAt: session.updatedAt || new Date().toISOString(),
    }
    const index = state.sessions.findIndex((item) => item.sessionId === next.sessionId)
    if (index >= 0) state.sessions[index] = next
    else state.sessions.push(next)
    await this.write(state)
    return next
  }

  async update(
    sessionId: string,
    patch: Partial<ConsultationSessionRecord>,
  ): Promise<ConsultationSessionRecord | null> {
    const state = await this.read()
    const current = state.sessions.find((item) => item.sessionId === sessionId)
    if (!current) return null
    Object.assign(current, patch, { updatedAt: new Date().toISOString() })
    await this.write(state)
    return current
  }

  async findActiveByTentacle(tentacleId: string): Promise<ConsultationSessionRecord[]> {
    const active = new Set<ConsultationSessionRecord["status"]>(["open", "waiting_user", "waiting_tentacle"])
    return (await this.read()).sessions.filter((session) => session.tentacleId === tentacleId && active.has(session.status))
  }

  async findByRecentPush(channelKeyMessageId: string): Promise<ConsultationSessionRecord | null> {
    return (await this.read()).sessions.find((session) => session.recentPushMessageId === channelKeyMessageId) ?? null
  }

  async close(sessionId: string, status: ConsultationSessionRecord["status"] = "closed"): Promise<void> {
    await this.update(sessionId, { status })
  }

  private async read(): Promise<ConsultationStateFile> {
    if (!existsSync(this.statePath)) {
      return { sessions: [] }
    }
    try {
      return JSON.parse(await fs.readFile(this.statePath, "utf-8")) as ConsultationStateFile
    } catch {
      return { sessions: [] }
    }
  }

  private async write(state: ConsultationStateFile): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true })
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), "utf-8")
  }
}
