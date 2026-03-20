import { spawn, type ChildProcess } from "child_process"
import * as crypto from "crypto"
import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import type { OpenCephConfig } from "../config/config-schema.js"
import { brainLogger, systemLogger, tentacleLog } from "../logger/index.js"
import { type IpcMessage } from "./contract.js"
import { IpcServer } from "./ipc-server.js"
import { PendingReportsQueue } from "./pending-reports.js"
import { TentacleRegistry, type TentacleRegistryEntry } from "./registry.js"

export interface TentacleStatus {
  tentacleId: string
  status: "running" | "paused" | "killed" | "crashed" | "registered"
  pid?: number
  purpose?: string
  runtime?: string
  updatedAt: string
}

interface TentacleMetadata {
  tentacleId: string
  purpose: string
  runtime: string
  entryCommand: string
  cwd?: string
  source?: string
  trigger?: string
  dataSources?: string[]
  createdAt?: string
}

export class TentacleManager {
  private processes: Map<string, ChildProcess> = new Map()
  private statusMap: Map<string, TentacleStatus> = new Map()
  private restartCounts: Map<string, number> = new Map()

  constructor(
    private config: OpenCephConfig,
    private ipcServer: IpcServer,
    private registry: TentacleRegistry,
    private pendingReports: PendingReportsQueue,
  ) {
    this.ipcServer.onMessage(async (tentacleId, message) => {
      await this.handleIpcMessage(tentacleId, message)
    })
  }

  async spawn(tentacleId: string): Promise<void> {
    if (this.processes.has(tentacleId)) return

    const metadata = await this.readMetadata(tentacleId)
    const child = spawn("bash", ["-lc", metadata.entryCommand], {
      cwd: metadata.cwd ?? this.getTentacleDir(tentacleId),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCEPH_SOCKET_PATH: this.config.tentacle.ipcSocketPath, OPENCEPH_TENTACLE_ID: tentacleId },
    })

    this.processes.set(tentacleId, child)
    this.statusMap.set(tentacleId, {
      tentacleId,
      status: "running",
      pid: child.pid,
      purpose: metadata.purpose,
      runtime: metadata.runtime,
      updatedAt: new Date().toISOString(),
    })

    await this.registry.register({
      tentacleId,
      status: "running",
      purpose: metadata.purpose,
      source: metadata.source ?? "manual",
      runtime: metadata.runtime,
      trigger: metadata.trigger ?? "manual",
      dataSources: metadata.dataSources?.join(", "),
      createdAt: metadata.createdAt ?? new Date().toISOString(),
      directory: metadata.cwd ?? this.getTentacleDir(tentacleId),
      health: "启动中",
    })

    systemLogger.info("tentacle_spawned", { tentacle_id: tentacleId, pid: child.pid })
    tentacleLog(tentacleId, "info", "tentacle_spawned", { pid: child.pid })

    child.stdout?.on("data", (chunk) => {
      tentacleLog(tentacleId, "info", "stdout", { text: chunk.toString("utf-8").slice(0, 1000) })
    })
    child.stderr?.on("data", (chunk) => {
      tentacleLog(tentacleId, "warn", "stderr", { text: chunk.toString("utf-8").slice(0, 1000) })
    })

    child.on("exit", (code) => {
      this.processes.delete(tentacleId)
      void this.handleCrash(tentacleId, code ?? -1)
    })
  }

  async kill(tentacleId: string, reason: string): Promise<boolean> {
    const proc = this.processes.get(tentacleId)
    if (!proc) return false
    proc.kill("SIGTERM")
    this.processes.delete(tentacleId)
    this.statusMap.set(tentacleId, {
      ...(this.statusMap.get(tentacleId) ?? { tentacleId, updatedAt: new Date().toISOString() }),
      status: "killed",
      updatedAt: new Date().toISOString(),
    })
    await this.registry.markKilled(tentacleId)
    tentacleLog(tentacleId, "info", "tentacle_killed", { reason })
    return true
  }

  async pause(tentacleId: string): Promise<boolean> {
    const proc = this.processes.get(tentacleId)
    if (!proc?.pid) return false
    process.kill(proc.pid, "SIGSTOP")
    this.statusMap.set(tentacleId, {
      ...(this.statusMap.get(tentacleId) ?? { tentacleId, updatedAt: new Date().toISOString() }),
      status: "paused",
      pid: proc.pid,
      updatedAt: new Date().toISOString(),
    })
    await this.registry.updateStatus(tentacleId, "paused")
    return true
  }

  async resume(tentacleId: string): Promise<boolean> {
    const proc = this.processes.get(tentacleId)
    if (!proc?.pid) return false
    process.kill(proc.pid, "SIGCONT")
    this.statusMap.set(tentacleId, {
      ...(this.statusMap.get(tentacleId) ?? { tentacleId, updatedAt: new Date().toISOString() }),
      status: "running",
      pid: proc.pid,
      updatedAt: new Date().toISOString(),
    })
    await this.registry.updateStatus(tentacleId, "running")
    return true
  }

  async runNow(tentacleId: string): Promise<boolean> {
    try {
      await this.ipcServer.sendToTentacle(tentacleId, {
        type: "heartbeat_trigger",
        sender: "brain",
        receiver: tentacleId,
        payload: { reason: "run_now" },
        timestamp: new Date().toISOString(),
        message_id: crypto.randomUUID(),
      })
      return true
    } catch {
      return false
    }
  }

  getStatus(tentacleId: string): TentacleStatus | undefined {
    return this.statusMap.get(tentacleId)
  }

  listAll(filter?: { status?: string }): TentacleStatus[] {
    const items = Array.from(this.statusMap.values()).sort((a, b) => a.tentacleId.localeCompare(b.tentacleId))
    if (!filter?.status || filter.status === "all") return items
    return items.filter((item) => item.status === filter.status)
  }

  async restoreFromRegistry(): Promise<void> {
    const entries = await this.registry.readAll()
    for (const entry of entries) {
      this.statusMap.set(entry.tentacleId, {
        tentacleId: entry.tentacleId,
        status: entry.status as TentacleStatus["status"],
        purpose: entry.purpose,
        runtime: entry.runtime,
        updatedAt: new Date().toISOString(),
      })
    }
  }

  async shutdown(): Promise<void> {
    const ids = Array.from(this.processes.keys())
    for (const id of ids) {
      await this.kill(id, "shutdown")
    }
  }

  async waitForRegistration(tentacleId: string, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (this.ipcServer.getConnectedTentacles().includes(tentacleId)) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }

  getTentacleDir(tentacleId: string): string {
    return path.join(this.getTentacleBaseDir(), tentacleId)
  }

  getTentacleBaseDir(): string {
    return path.join(path.dirname(this.config.tentacle.ipcSocketPath), "tentacles")
  }

  private async handleCrash(tentacleId: string, exitCode: number): Promise<void> {
    const current = this.statusMap.get(tentacleId)
    if (current?.status === "killed") return

    const restartAttempt = (this.restartCounts.get(tentacleId) ?? 0) + 1
    this.restartCounts.set(tentacleId, restartAttempt)
    systemLogger.warn("tentacle_crash", { tentacle_id: tentacleId, exit_code: exitCode, restart_attempt: restartAttempt })

    if (restartAttempt >= this.config.tentacle.crashRestartMaxAttempts) {
      this.statusMap.set(tentacleId, {
        ...(current ?? { tentacleId, updatedAt: new Date().toISOString() }),
        status: "crashed",
        updatedAt: new Date().toISOString(),
      })
      await this.registry.updateStatus(tentacleId, "crashed", { health: "崩溃" })
      systemLogger.error("tentacle_crash_permanent", { tentacle_id: tentacleId })
      return
    }

    const delayMs = 2 ** (restartAttempt - 1) * 1000
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    await this.spawn(tentacleId)
  }

  private async handleIpcMessage(tentacleId: string, message: IpcMessage): Promise<void> {
    if (message.type === "tentacle_register") {
      const payload = message.payload as { purpose?: string; runtime?: string }
      this.statusMap.set(tentacleId, {
        tentacleId,
        status: "running",
        pid: this.processes.get(tentacleId)?.pid,
        purpose: payload.purpose,
        runtime: payload.runtime,
        updatedAt: new Date().toISOString(),
      })
      await this.registry.updateStatus(tentacleId, "running", {
        purpose: payload.purpose ?? "",
        runtime: payload.runtime ?? "unknown",
        health: "良好",
      })
      systemLogger.info("tentacle_registered", { tentacle_id: tentacleId, runtime: payload.runtime })
      return
    }

    if (message.type === "report_finding") {
      const payload = message.payload as { findingId?: string; summary?: string; confidence?: number }
      const findingId = payload.findingId ?? crypto.randomUUID()
      await this.pendingReports.add({
        findingId,
        tentacleId,
        summary: payload.summary ?? "",
        confidence: payload.confidence ?? 0,
        createdAt: new Date().toISOString(),
        status: "pending",
      })
      brainLogger.info("tentacle_report_received", { tentacle_id: tentacleId, finding_id: findingId })
      brainLogger.info("tentacle_report_queued", { tentacle_id: tentacleId, finding_id: findingId })
      await this.registry.updateStatus(tentacleId, this.statusMap.get(tentacleId)?.status ?? "running", {
        lastReport: new Date().toISOString(),
      })
    }
  }

  private async readMetadata(tentacleId: string): Promise<TentacleMetadata> {
    const metadataPath = path.join(this.getTentacleDir(tentacleId), "tentacle.json")
    if (!existsSync(metadataPath)) {
      throw new Error(`Missing tentacle metadata: ${metadataPath}`)
    }
    return JSON.parse(await fs.readFile(metadataPath, "utf-8")) as TentacleMetadata
  }

}
