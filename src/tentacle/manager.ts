import { spawn, type ChildProcess } from "child_process"
import * as crypto from "crypto"
import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import type { OpenCephConfig } from "../config/config-schema.js"
import { buildTentacleModelEnv } from "../config/model-runtime.js"
import { brainLogger, systemLogger, tentacleLog } from "../logger/index.js"
import { updateRuntimeStatus } from "../logger/runtime-status-store.js"
import type {
  ConsultationClosePayload,
  ConsultationEndPayload,
  ConsultationMessagePayload,
  ConsultationReplyPayload,
  ConsultationRequestPayload,
  DirectivePayload,
  HeartbeatResultPayload,
  HeartbeatTriggerPayload,
  IpcMessage,
  ReportFindingPayload,
  TentacleRegisterPayload,
  ToolRequestPayload,
  ToolResultPayload,
} from "./contract.js"
import { createIpcMessage } from "./contract.js"
import { IpcServer } from "./ipc-server.js"
import { PendingReportsQueue } from "./pending-reports.js"
import { TentacleRegistry } from "./registry.js"
import type { TentacleScheduleConfig } from "./tentacle-schedule.js"
import type { CronScheduler } from "../cron/cron-scheduler.js"
import { parseDurationMs } from "../cron/time.js"
import { getTentacleLogsDir } from "../logger/log-paths.js"

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
  private toolRequestHandler: ((input: {
    tentacleId: string
    payload: ToolRequestPayload
  }) => Promise<ToolResultPayload>) | null = null
  private consultationMessageHandler: ((input: {
    tentacleId: string
    payload: ConsultationMessagePayload
  }) => Promise<void>) | null = null
  private consultationEndHandler: ((input: {
    tentacleId: string
    payload: ConsultationEndPayload
  }) => Promise<void>) | null = null

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

  setToolRequestHandler(
    handler: (input: {
      tentacleId: string
      payload: ToolRequestPayload
    }) => Promise<ToolResultPayload>,
  ): void {
    this.toolRequestHandler = handler
  }

  setConsultationMessageHandler(
    handler: (input: {
      tentacleId: string
      payload: ConsultationMessagePayload
    }) => Promise<void>,
  ): void {
    this.consultationMessageHandler = handler
  }

  setConsultationEndHandler(
    handler: (input: {
      tentacleId: string
      payload: ConsultationEndPayload
    }) => Promise<void>,
  ): void {
    this.consultationEndHandler = handler
  }

  async spawn(tentacleId: string): Promise<void> {
    if (this.processes.has(tentacleId)) return

    const metadata = await this.readMetadata(tentacleId)
    const scheduleConfig = metadata.scheduleConfig ?? inferScheduleConfig(metadata.trigger)
    const modelEnv = buildTentacleModelEnv(this.config)
    const runtimeDir = this.getTentacleRuntimeDir(tentacleId)
    await fs.mkdir(runtimeDir, { recursive: true })
    const selfScheduleInterval = scheduleConfig.primaryTrigger.type === "self-schedule"
      ? scheduleConfig.primaryTrigger.interval
      : undefined
    const child = spawn("bash", ["-lc", metadata.entryCommand], {
      cwd: metadata.cwd ?? this.getTentacleDir(tentacleId),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...modelEnv,
        OPENCEPH_SOCKET_PATH: this.config.tentacle.ipcSocketPath,
        OPENCEPH_TENTACLE_ID: tentacleId,
        OPENCEPH_TRIGGER_MODE: scheduleConfig.primaryTrigger.type === "self-schedule" ? "self" : "external",
        OPENCEPH_TENTACLE_DIR: metadata.cwd ?? this.getTentacleDir(tentacleId),
        OPENCEPH_RUNTIME_DIR: runtimeDir,
        OPENCEPH_SELF_SCHEDULE: selfScheduleInterval ?? "",
        OPENCEPH_SELF_INTERVAL_SECONDS: this.toSelfIntervalSeconds(selfScheduleInterval),
      },
    })
    this.ipcServer.attachProcess(tentacleId, {
      stdin: child.stdin,
      stdout: child.stdout,
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
    void this.appendRuntimeOutput(
      tentacleId,
      "event",
      `[event] ${new Date().toISOString()} tentacle_spawned pid=${child.pid ?? "unknown"} command=${metadata.entryCommand}\n`,
    )

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf-8")
      tentacleLog(tentacleId, "info", "stdout", { text: text.slice(0, 1000) })
      void this.appendRuntimeOutput(tentacleId, "stdout", text)
    })
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf-8")
      tentacleLog(tentacleId, "warn", "stderr", { text: text.slice(0, 1000) })
      void this.appendRuntimeOutput(tentacleId, "stderr", text)
    })

    child.on("exit", (code) => {
      this.processes.delete(tentacleId)
      this.ipcServer.disconnect(tentacleId)
      void this.appendRuntimeOutput(
        tentacleId,
        "event",
        `[event] ${new Date().toISOString()} process_exit code=${code ?? -1}\n`,
      )
      void this.handleCrash(tentacleId, code ?? -1)
    })
  }

  async kill(tentacleId: string, reason: string): Promise<boolean> {
    const proc = this.processes.get(tentacleId)
    if (proc) {
      proc.kill("SIGTERM")
      this.processes.delete(tentacleId)
    } else if (!this.isKnownTentacle(tentacleId)) {
      return false
    }
    this.ipcServer.disconnect(tentacleId)
    await this.clearTentacleScheduling(tentacleId)
    this.updateStatus(tentacleId, { status: "killed" })
    await this.registry.markKilled(tentacleId)
    tentacleLog(tentacleId, "info", "tentacle_killed", { reason })
    void this.appendRuntimeOutput(
      tentacleId,
      "event",
      `[event] ${new Date().toISOString()} tentacle_killed reason=${reason}\n`,
    )
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
    if (proc?.pid) {
      process.kill(proc.pid, "SIGCONT")
      await this.setRelatedJobsEnabled(tentacleId, true)
      this.updateStatus(tentacleId, { status: "running" })
      await this.syncRegistry(tentacleId, "running")
      return true
    }

    if (!this.isKnownTentacle(tentacleId)) {
      return false
    }

    await this.spawn(tentacleId)
    const registered = await this.waitForRegistration(tentacleId, 10_000)
    if (!registered) {
      await this.kill(tentacleId, "resume_registration_timeout").catch(() => undefined)
      return false
    }
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

  async sendConsultationReply(tentacleId: string, payload: ConsultationReplyPayload): Promise<void> {
    await this.ipcServer.sendToTentacle(tentacleId, createIpcMessage("consultation_reply", tentacleId, payload))
  }

  async sendConsultationClose(tentacleId: string, payload: ConsultationClosePayload): Promise<void> {
    await this.ipcServer.sendToTentacle(tentacleId, createIpcMessage("consultation_close", tentacleId, payload))
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

  async respawnFromRegistry(): Promise<void> {
    for (const [tentacleId, status] of this.statusMap.entries()) {
      if (status.status !== "running") continue
      if (this.processes.has(tentacleId)) continue // already running

      const tentacleDir = this.getTentacleDir(tentacleId)
      const metaPath = path.join(tentacleDir, "tentacle.json")
      if (!existsSync(metaPath)) {
        this.updateStatus(tentacleId, { status: "crashed", healthScore: 0 })
        systemLogger.warn("respawn_skip_no_metadata", { tentacle_id: tentacleId })
        continue
      }

      try {
        await this.spawn(tentacleId)
        systemLogger.info("respawn_ok", { tentacle_id: tentacleId })
      } catch (err: any) {
        this.updateStatus(tentacleId, { status: "crashed", healthScore: 0 })
        systemLogger.error("respawn_failed", { tentacle_id: tentacleId, error: err.message })
      }
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

  getTentacleRuntimeDir(tentacleId: string): string {
    return getTentacleLogsDir(
      this.config.logging?.logDir ?? path.join(path.dirname(this.config.tentacle.ipcSocketPath), "logs"),
      tentacleId,
    )
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
    tentacleLog(tentacleId, "warn", "tentacle_crash", { exit_code: exitCode, restart_attempt: restartAttempt })
    void this.appendRuntimeOutput(
      tentacleId,
      "event",
      `[event] ${new Date().toISOString()} tentacle_crash exit_code=${exitCode} restart_attempt=${restartAttempt}\n`,
    )

    if (restartAttempt >= this.config.tentacle.crashRestartMaxAttempts) {
      this.updateStatus(tentacleId, { status: "crashed", healthScore: 0 })
      await this.registry.updateStatus(tentacleId, "crashed", { health: "崩溃" })
      systemLogger.error("tentacle_crash_permanent", { tentacle_id: tentacleId })
      tentacleLog(tentacleId, "error", "tentacle_crash_permanent", { exit_code: exitCode })
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
            session_id: payload.session_id ?? payload.request_id,
            requestId: payload.request_id,
            status: "closed" as const,
            decision: "discard" as const,
            approvedItemIds: [],
            queuedPushCount: 0,
            notes: "auto consultation reply",
            consultation_id: crypto.randomUUID(),
            message: "auto consultation reply",
            actions_taken: [],
            continue: false,
          }
      // Per protocol: send reply first, then close if conversation is done
      await this.sendConsultationReply(tentacleId, replyPayload)

      // Send consultation_close after reply when continue=false (per protocol §4.2)
      if (replyPayload.continue === false) {
        const pushedCount = replyPayload.actions_taken?.filter(a => a.action === "pushed_to_user").length ?? replyPayload.queuedPushCount ?? 0
        const discardedCount = (payload.items?.length ?? payload.item_count ?? 0) - pushedCount
        await this.sendConsultationClose(tentacleId, {
          consultation_id: replyPayload.consultation_id ?? replyPayload.session_id ?? payload.request_id,
          summary: replyPayload.notes ?? "",
          pushed_count: pushedCount,
          discarded_count: Math.max(0, discardedCount),
          feedback: undefined,
        })
      }

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

    if (message.type === "consultation_message") {
      const payload = message.payload as ConsultationMessagePayload
      if (this.consultationMessageHandler) {
        await this.consultationMessageHandler({ tentacleId, payload })
      } else {
        brainLogger.warn("consultation_message_no_handler", {
          tentacle_id: tentacleId,
          consultation_id: payload.consultation_id,
        })
      }
      return
    }

    if (message.type === "consultation_end") {
      const payload = message.payload as ConsultationEndPayload
      if (this.consultationEndHandler) {
        await this.consultationEndHandler({ tentacleId, payload })
      } else {
        brainLogger.warn("consultation_end_no_handler", {
          tentacle_id: tentacleId,
          consultation_id: payload.consultation_id,
        })
      }
      return
    }

    if (message.type === "tool_request") {
      const payload = message.payload as ToolRequestPayload
      if (this.toolRequestHandler) {
        try {
          const result = await this.toolRequestHandler({ tentacleId, payload })
          await this.ipcServer.sendToTentacle(tentacleId, createIpcMessage("tool_result", tentacleId, result))
        } catch (error: any) {
          const errorResult: ToolResultPayload = {
            tool_call_id: payload.tool_call_id,
            result: {},
            success: false,
            error: error.message ?? "tool_request handler error",
          }
          await this.ipcServer.sendToTentacle(tentacleId, createIpcMessage("tool_result", tentacleId, errorResult))
        }
      } else {
        const errorResult: ToolResultPayload = {
          tool_call_id: payload.tool_call_id,
          result: {},
          success: false,
          error: "No tool request handler registered",
        }
        await this.ipcServer.sendToTentacle(tentacleId, createIpcMessage("tool_result", tentacleId, errorResult))
      }
      brainLogger.info("tentacle_tool_request", {
        tentacle_id: tentacleId,
        tool_name: payload.tool_name,
        tool_call_id: payload.tool_call_id,
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
      const ids = new Set([reply.consultation_id, (request as any).session_id, (request as any).request_id].filter(Boolean))
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

  private isKnownTentacle(tentacleId: string): boolean {
    return this.statusMap.has(tentacleId) || existsSync(path.join(this.getTentacleDir(tentacleId), "tentacle.json"))
  }

  private toSelfIntervalSeconds(interval?: string): string {
    if (!interval) return "3600"
    try {
      return String(Math.max(1, Math.round(parseDurationMs(interval) / 1000)))
    } catch {
      systemLogger.warn(`Failed to parse interval "${interval}", using default 3600s`)
      return "3600"
    }
  }

  private async appendRuntimeOutput(
    tentacleId: string,
    stream: "stdout" | "stderr" | "event",
    text: string,
  ): Promise<void> {
    const runtimeDir = this.getTentacleRuntimeDir(tentacleId)
    try {
      await fs.mkdir(runtimeDir, { recursive: true })
      const fileName = stream === "event" ? "terminal.log" : `${stream}.log`
      await fs.appendFile(path.join(runtimeDir, fileName), text, "utf-8")
      if (stream !== "event") {
        const combinedLine = text
          .split(/(?<=\n)/)
          .filter(Boolean)
          .map((part) => `[${stream}] ${part}`)
          .join("")
        await fs.appendFile(path.join(runtimeDir, "terminal.log"), combinedLine, "utf-8")
      }
    } catch {
      // Runtime logging must never crash the manager.
    }
  }
}

function inferScheduleConfig(trigger?: string): TentacleScheduleConfig {
  if (trigger && /^\d+(?:\.\d+)?(?:ms|s|m|h|d|w)$/.test(trigger)) {
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
