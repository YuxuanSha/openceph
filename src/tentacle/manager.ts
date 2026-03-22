import { spawn, type ChildProcess } from "child_process"
import * as crypto from "crypto"
import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import type { OpenCephConfig } from "../config/config-schema.js"
import { brainLogger, systemLogger, tentacleLog } from "../logger/index.js"
import { updateRuntimeStatus } from "../logger/runtime-status-store.js"
import type {
  ConsultationReplyPayload,
  ConsultationRequestPayload,
  DirectivePayload,
  HeartbeatResultPayload,
  HeartbeatTriggerPayload,
  IpcMessage,
  ReportFindingPayload,
  TentacleRegisterPayload,
} from "./contract.js"
import { IpcServer } from "./ipc-server.js"
import { PendingReportsQueue } from "./pending-reports.js"
import { TentacleRegistry } from "./registry.js"
import type { TentacleScheduleConfig } from "./tentacle-schedule.js"
import type { CronScheduler } from "../cron/cron-scheduler.js"
import { parseDurationMs } from "../cron/time.js"

export interface TentacleStatus {
  tentacleId: string
  id: string
  purpose?: string
  sourceSkill?: string
  runtime?: string
  triggerType: "schedule" | "event" | "manual"
  triggerSchedule?: string
  status: "pending" | "deploying" | "running" | "paused" | "weakened" | "killed" | "crashed" | "registered"
  pid?: number
  createdAt: string
  updatedAt: string
  lastReportAt?: string
  totalReports: number
  totalFindings: number
  healthScore: number
  directory: string
  scheduleConfig?: TentacleScheduleConfig
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
  skillName?: string
  scheduleConfig?: TentacleScheduleConfig
}

export class TentacleManager {
  private processes: Map<string, ChildProcess> = new Map()
  private statusMap: Map<string, TentacleStatus> = new Map()
  private restartCounts: Map<string, number> = new Map()
  private cronScheduler: CronScheduler | null = null
  private consultationHandler: ((input: {
    tentacleId: string
    payload: ConsultationRequestPayload
  }) => Promise<ConsultationReplyPayload>) | null = null
  private adjustmentHandler: ((input: {
    tentacleId: string
    adjustment: NonNullable<HeartbeatResultPayload["adjustments"]>[number]
    currentSchedule: TentacleScheduleConfig | null
  }) => Promise<boolean>) | null = null

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

  setCronScheduler(cronScheduler: CronScheduler): void {
    this.cronScheduler = cronScheduler
  }

  getCronScheduler(): CronScheduler | null {
    return this.cronScheduler
  }

  setConsultationHandler(
    handler: (input: {
      tentacleId: string
      payload: ConsultationRequestPayload
    }) => Promise<ConsultationReplyPayload>,
  ): void {
    this.consultationHandler = handler
  }

  setAdjustmentHandler(
    handler: (input: {
      tentacleId: string
      adjustment: NonNullable<HeartbeatResultPayload["adjustments"]>[number]
      currentSchedule: TentacleScheduleConfig | null
    }) => Promise<boolean>,
  ): void {
    this.adjustmentHandler = handler
  }

  async spawn(tentacleId: string): Promise<void> {
    if (this.processes.has(tentacleId)) return

    const metadata = await this.readMetadata(tentacleId)
    const scheduleConfig = metadata.scheduleConfig ?? inferScheduleConfig(metadata.trigger)
    const child = spawn("bash", ["-lc", metadata.entryCommand], {
      cwd: metadata.cwd ?? this.getTentacleDir(tentacleId),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCEPH_SOCKET_PATH: this.config.tentacle.ipcSocketPath,
        OPENCEPH_TENTACLE_ID: tentacleId,
        OPENCEPH_TRIGGER_MODE: scheduleConfig.primaryTrigger.type === "self-schedule" ? "self" : "external",
      },
    })

    this.processes.set(tentacleId, child)
    this.statusMap.set(tentacleId, {
      tentacleId,
      id: tentacleId,
      status: "running",
      pid: child.pid,
      purpose: metadata.purpose,
      sourceSkill: metadata.skillName,
      runtime: metadata.runtime,
      triggerType: scheduleConfig.primaryTrigger.type === "self-schedule" ? "schedule" : "event",
      triggerSchedule: describeSchedule(scheduleConfig),
      createdAt: metadata.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalReports: 0,
      totalFindings: 0,
      healthScore: 100,
      directory: metadata.cwd ?? this.getTentacleDir(tentacleId),
      scheduleConfig,
    })

    await this.syncRegistry(tentacleId, "running")

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
    await this.clearTentacleScheduling(tentacleId)
    this.updateStatus(tentacleId, { status: "killed" })
    await this.registry.markKilled(tentacleId)
    tentacleLog(tentacleId, "info", "tentacle_killed", { reason })
    return true
  }

  async pause(tentacleId: string): Promise<boolean> {
    const proc = this.processes.get(tentacleId)
    if (!proc?.pid) return false
    process.kill(proc.pid, "SIGSTOP")
    await this.setRelatedJobsEnabled(tentacleId, false)
    this.updateStatus(tentacleId, { status: "paused" })
    await this.syncRegistry(tentacleId, "paused")
    return true
  }

  async resume(tentacleId: string): Promise<boolean> {
    const proc = this.processes.get(tentacleId)
    if (!proc?.pid) return false
    process.kill(proc.pid, "SIGCONT")
    await this.setRelatedJobsEnabled(tentacleId, true)
    this.updateStatus(tentacleId, { status: "running" })
    await this.syncRegistry(tentacleId, "running")
    return true
  }

  async weaken(tentacleId: string, reason: string): Promise<boolean> {
    const status = this.statusMap.get(tentacleId)
    if (!status) return false
    await this.setRelatedJobsEnabled(tentacleId, false)
    this.updateStatus(tentacleId, {
      status: "weakened",
      healthScore: Math.max(0, status.healthScore - 30),
    })
    await this.syncRegistry(tentacleId, "weakened")
    tentacleLog(tentacleId, "warn", "tentacle_weakened", { reason })
    return true
  }

  async runNow(tentacleId: string): Promise<boolean> {
    try {
      await this.sendDirective(tentacleId, { action: "run_now", reason: "manual" })
      return true
    } catch {
      return false
    }
  }

  async triggerCronJob(jobId: string, tentacleId: string): Promise<boolean> {
    try {
      await this.sendDirective(tentacleId, { action: "run_now", reason: `cron:${jobId}` })
      tentacleLog(tentacleId, "info", "tentacle_cron_triggered", { job_id: jobId })
      return true
    } catch (error: any) {
      tentacleLog(tentacleId, "error", "tentacle_cron_trigger_failed", { job_id: jobId, error: error.message })
      return false
    }
  }

  async triggerHeartbeatReview(tentacleId: string, prompt: string, jobId: string): Promise<boolean> {
    try {
      await this.sendHeartbeatTrigger(tentacleId, prompt)
      tentacleLog(tentacleId, "info", "tentacle_heartbeat_triggered", { job_id: jobId })
      return true
    } catch (error: any) {
      tentacleLog(tentacleId, "error", "tentacle_heartbeat_trigger_failed", { job_id: jobId, error: error.message })
      return false
    }
  }

  async setTentacleSchedule(tentacleId: string, schedule: TentacleScheduleConfig): Promise<void> {
    const metadata = await this.readMetadata(tentacleId)
    metadata.scheduleConfig = schedule
    if (schedule.primaryTrigger.type !== "self-schedule") {
      await this.sendDirective(tentacleId, { action: "set_trigger_mode", triggerMode: "external" }).catch(() => undefined)
    } else {
      await this.sendDirective(tentacleId, {
        action: "set_self_schedule",
        triggerMode: "self",
        interval: schedule.primaryTrigger.interval,
      }).catch(() => undefined)
    }
    await this.writeMetadata(tentacleId, metadata)
    this.updateStatus(tentacleId, {
      triggerType: schedule.primaryTrigger.type === "self-schedule" ? "schedule" : "event",
      triggerSchedule: describeSchedule(schedule),
      scheduleConfig: schedule,
    })
    await this.syncRegistry(tentacleId, this.getStatus(tentacleId)?.status ?? "running")
  }

  async getTentacleSchedule(tentacleId: string): Promise<TentacleScheduleConfig | null> {
    try {
      const metadata = await this.readMetadata(tentacleId)
      return metadata.scheduleConfig ?? null
    } catch {
      return this.statusMap.get(tentacleId)?.scheduleConfig ?? null
    }
  }

  async forwardConsultationDirective(tentacleId: string, payload: DirectivePayload["consultation"]): Promise<void> {
    await this.sendDirective(tentacleId, {
      action: "consultation_followup",
      consultation: payload,
    })
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
      const scheduleConfig = parseScheduleConfig(entry.scheduleConfig)
      this.statusMap.set(entry.tentacleId, {
        tentacleId: entry.tentacleId,
        id: entry.tentacleId,
        status: entry.status as TentacleStatus["status"],
        purpose: entry.purpose,
        runtime: entry.runtime,
        triggerType: scheduleConfig?.primaryTrigger.type === "self-schedule" ? "schedule" : "event",
        triggerSchedule: scheduleConfig ? describeSchedule(scheduleConfig) : entry.trigger,
        createdAt: entry.createdAt,
        updatedAt: new Date().toISOString(),
        lastReportAt: entry.lastReport,
        totalReports: 0,
        totalFindings: 0,
        healthScore: entry.health === "崩溃" ? 0 : 100,
        directory: entry.directory ?? this.getTentacleDir(entry.tentacleId),
        scheduleConfig,
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
      this.updateStatus(tentacleId, { status: "crashed", healthScore: 0 })
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
      const payload = message.payload as TentacleRegisterPayload
      this.updateStatus(tentacleId, {
        status: "running",
        pid: this.processes.get(tentacleId)?.pid,
        purpose: payload.purpose,
        runtime: payload.runtime,
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
      const payload = message.payload as ReportFindingPayload
      const findingId = payload.findingId ?? crypto.randomUUID()
      await this.pendingReports.add({
        findingId,
        tentacleId,
        summary: payload.summary ?? "",
        confidence: payload.confidence ?? 0,
        createdAt: new Date().toISOString(),
        status: "pending",
      })
      this.incrementReportCounters(tentacleId)
      brainLogger.info("tentacle_report_received", { tentacle_id: tentacleId, finding_id: findingId })
      brainLogger.info("tentacle_report_queued", { tentacle_id: tentacleId, finding_id: findingId })
      await this.registry.updateStatus(tentacleId, this.statusMap.get(tentacleId)?.status ?? "running", {
        lastReport: new Date().toISOString(),
      })
      return
    }

    if (message.type === "consultation_request") {
      const payload = message.payload as ConsultationRequestPayload
      const replyPayload: ConsultationReplyPayload = this.consultationHandler
        ? await this.consultationHandler({
            tentacleId,
            payload,
          })
        : {
            decision: payload.mode === "action_confirm" ? "send" : "discard",
            requestId: payload.request_id,
            approvedItemIds: [],
            queuedPushCount: 0,
            session_id: payload.session_id ?? payload.request_id,
            status: payload.mode === "action_confirm" ? "waiting_user" : "closed",
            notes: "auto consultation reply",
            next_action: payload.mode === "action_confirm" ? "await_user" : "none",
          }
      await this.ipcServer.sendToTentacle(tentacleId, {
        type: "consultation_reply",
        sender: "brain",
        receiver: tentacleId,
        payload: replyPayload,
        timestamp: new Date().toISOString(),
        message_id: crypto.randomUUID(),
      })
      await this.archiveConsultation(tentacleId, payload, replyPayload)
      this.incrementReportCounters(tentacleId)
      await this.registry.updateStatus(tentacleId, this.statusMap.get(tentacleId)?.status ?? "running", {
        lastReport: new Date().toISOString(),
      })
      brainLogger.info("tentacle_consultation_replied", {
        tentacle_id: tentacleId,
        request_id: payload.request_id,
        mode: payload.mode,
        decision: replyPayload.decision ?? "unknown",
      })
      return
    }

    if (message.type === "heartbeat_result") {
      const payload = message.payload as HeartbeatResultPayload
      brainLogger.info("tentacle_heartbeat_result", {
        tentacle_id: tentacleId,
        status: payload.status,
        adjustments: payload.adjustments?.length ?? 0,
      })
      tentacleLog(tentacleId, "info", "tentacle_heartbeat_result", payload as unknown as Record<string, unknown>)
      for (const adjustment of payload.adjustments ?? []) {
        const approved = this.adjustmentHandler
          ? await this.adjustmentHandler({
              tentacleId,
              adjustment,
              currentSchedule: await this.getTentacleSchedule(tentacleId),
            })
          : false
        if (approved) {
          await this.applyAdjustment(tentacleId, adjustment)
        }
      }
      return
    }
  }

  private async readMetadata(tentacleId: string): Promise<TentacleMetadata> {
    const metadataPath = path.join(this.getTentacleDir(tentacleId), "tentacle.json")
    if (!existsSync(metadataPath)) {
      throw new Error(`Missing tentacle metadata: ${metadataPath}`)
    }
    return JSON.parse(await fs.readFile(metadataPath, "utf-8")) as TentacleMetadata
  }

  private async writeMetadata(tentacleId: string, metadata: TentacleMetadata): Promise<void> {
    const metadataPath = path.join(this.getTentacleDir(tentacleId), "tentacle.json")
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8")
  }

  private updateStatus(tentacleId: string, patch: Partial<TentacleStatus>): void {
    const current = this.statusMap.get(tentacleId)
    const next: TentacleStatus = {
      ...current,
      tentacleId,
      id: tentacleId,
      status: patch.status ?? current?.status ?? "pending",
      triggerType: patch.triggerType ?? current?.triggerType ?? "manual",
      createdAt: patch.createdAt ?? current?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalReports: patch.totalReports ?? current?.totalReports ?? 0,
      totalFindings: patch.totalFindings ?? current?.totalFindings ?? 0,
      healthScore: patch.healthScore ?? current?.healthScore ?? 100,
      directory: patch.directory ?? current?.directory ?? this.getTentacleDir(tentacleId),
      ...patch,
    }
    this.statusMap.set(tentacleId, next)
    void this.writeRuntimeStatus()
  }

  private incrementReportCounters(tentacleId: string): void {
    const current = this.statusMap.get(tentacleId)
    this.updateStatus(tentacleId, {
      totalReports: (current?.totalReports ?? 0) + 1,
      totalFindings: (current?.totalFindings ?? 0) + 1,
      lastReportAt: new Date().toISOString(),
    })
  }

  private async syncRegistry(tentacleId: string, status: string): Promise<void> {
    const current = this.statusMap.get(tentacleId)
    if (!current) return
    await this.registry.register({
      tentacleId,
      status,
      purpose: current.purpose ?? "",
      source: current.sourceSkill ? `skill:${current.sourceSkill}` : "manual",
      runtime: current.runtime,
      trigger: current.triggerSchedule ?? current.triggerType,
      createdAt: current.createdAt,
      directory: current.directory,
      lastReport: current.lastReportAt,
      health: current.healthScore > 0 ? "良好" : "崩溃",
      scheduleConfig: current.scheduleConfig ? JSON.stringify(current.scheduleConfig) : undefined,
    })
  }

  private async writeRuntimeStatus(): Promise<void> {
    const items = Array.from(this.statusMap.values()).map((item) => ({
      tentacleId: item.tentacleId,
      status: item.status,
      pid: item.pid,
      purpose: item.purpose,
      healthScore: item.healthScore,
      lastReportAt: item.lastReportAt,
      updatedAt: item.updatedAt,
    }))
    await updateRuntimeStatus((current) => ({
      ...current,
      tentacles: items,
    }))
  }

  private async archiveConsultation(
    tentacleId: string,
    request: ConsultationRequestPayload,
    reply: ConsultationReplyPayload,
  ): Promise<void> {
    try {
      const sessionsDir = path.join(this.getTentacleDir(tentacleId), "sessions")
      await fs.mkdir(sessionsDir, { recursive: true })
      const archived = JSON.stringify({
        tentacleId,
        request,
        reply,
        archivedAt: new Date().toISOString(),
      }, null, 2)
      const ids = new Set([reply.session_id, request.session_id, request.request_id].filter(Boolean))
      for (const id of ids) {
        await fs.writeFile(path.join(sessionsDir, `${id}.json`), archived, "utf-8")
      }
    } catch (error: any) {
      tentacleLog(tentacleId, "warn", "consultation_archive_failed", { error: error.message })
    }
  }

  private async setRelatedJobsEnabled(tentacleId: string, enabled: boolean): Promise<void> {
    if (!this.cronScheduler) return
    const jobs = this.cronScheduler.listJobs().filter((job) => job.tentacleId === tentacleId)
    for (const job of jobs) {
      await this.cronScheduler.updateJob(job.jobId, { enabled })
    }
  }

  private async clearTentacleScheduling(tentacleId: string): Promise<void> {
    if (!this.cronScheduler) return
    const jobs = this.cronScheduler.listJobs().filter((job) => job.tentacleId === tentacleId)
    for (const job of jobs) {
      await this.cronScheduler.removeJob(job.jobId)
    }
  }

  private async sendDirective(tentacleId: string, payload: DirectivePayload): Promise<void> {
    await this.ipcServer.sendToTentacle(tentacleId, {
      type: "directive",
      sender: "brain",
      receiver: tentacleId,
      payload,
      timestamp: new Date().toISOString(),
      message_id: crypto.randomUUID(),
    })
  }

  private async sendHeartbeatTrigger(tentacleId: string, prompt: string): Promise<void> {
    const payload: HeartbeatTriggerPayload = { tentacle_id: tentacleId, prompt }
    await this.ipcServer.sendToTentacle(tentacleId, {
      type: "heartbeat_trigger",
      sender: "brain",
      receiver: tentacleId,
      payload,
      timestamp: new Date().toISOString(),
      message_id: crypto.randomUUID(),
    })
  }

  private async applyAdjustment(
    tentacleId: string,
    adjustment: NonNullable<HeartbeatResultPayload["adjustments"]>[number],
  ): Promise<void> {
    if (adjustment.type !== "change_frequency") return
    const newInterval = String(adjustment.params.new_interval ?? adjustment.params.interval ?? "").trim()
    if (!newInterval) return
    const current = await this.getTentacleSchedule(tentacleId)
    if (!current) return

    if (current.heartbeat?.enabled && current.heartbeat.jobId && this.cronScheduler) {
      await this.cronScheduler.updateJob(current.heartbeat.jobId, {
        schedule: { kind: "every", everyMs: parseDurationMs(newInterval) },
      })
      await this.setTentacleSchedule(tentacleId, {
        ...current,
        heartbeat: { ...current.heartbeat, every: newInterval },
      })
      return
    }

    await this.setTentacleSchedule(tentacleId, {
      primaryTrigger: { type: "self-schedule", interval: newInterval },
      cronJobs: [],
      heartbeat: current.heartbeat,
    })
  }
}

function inferScheduleConfig(trigger?: string): TentacleScheduleConfig {
  if (trigger && /^\d+(?:ms|s|m|h|d|w)$/.test(trigger)) {
    return { primaryTrigger: { type: "self-schedule", interval: trigger } }
  }
  return { primaryTrigger: { type: "self-schedule", interval: "6h" } }
}

function describeSchedule(config: TentacleScheduleConfig): string {
  const primary = config.primaryTrigger.type === "self-schedule"
    ? `self:${config.primaryTrigger.interval}`
    : config.primaryTrigger.type === "cron"
      ? `cron:${config.primaryTrigger.jobId}`
      : "heartbeat-driven"
  const heartbeat = config.heartbeat?.enabled ? ` heartbeat=${config.heartbeat.every}` : ""
  const cronJobs = config.cronJobs?.length ? ` cronJobs=${config.cronJobs.length}` : ""
  return `${primary}${heartbeat}${cronJobs}`.trim()
}

function parseScheduleConfig(value?: string): TentacleScheduleConfig | undefined {
  if (!value || value === "-") return undefined
  try {
    return JSON.parse(value) as TentacleScheduleConfig
  } catch {
    if (/^self:/.test(value)) {
      return { primaryTrigger: { type: "self-schedule", interval: value.slice("self:".length) } }
    }
    return undefined
  }
}

void parseDurationMs
