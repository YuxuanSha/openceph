import type { PiContext } from "../pi/pi-context.js"
import type { OpenCephConfig } from "../config/config-schema.js"
import type { Brain } from "../brain/brain.js"
import type { TentacleManager } from "../tentacle/manager.js"
import type { MemoryManager } from "../memory/memory-manager.js"
import type { CronScheduler } from "../cron/cron-scheduler.js"
import { brainLogger } from "../logger/index.js"

export interface HeartbeatResult {
  action: "ok" | "acted"
  tasksChecked: number
  actionsPerformed: number
  durationMs: number
}

export class HeartbeatRunner {
  constructor(
    private piCtx: PiContext,
    private config: OpenCephConfig,
    private brain: Brain,
    private tentacleManager: TentacleManager | null,
    private memoryManager: MemoryManager,
    private cronScheduler: CronScheduler,
  ) {}

  async runHeartbeat(): Promise<HeartbeatResult> {
    const startedAt = Date.now()
    const queuedEvents = await this.cronScheduler.drainPendingSystemEvents()
    const tentacles = this.tentacleManager?.listAll() ?? []
    const tentacleCount = tentacles.length
    const pendingReports = await this.brain.getPendingReportCount()

    const parts = [
      "Read HEARTBEAT.md. Follow it strictly.",
      "Check tentacle status, pending reports, and due items.",
      "If nothing needs attention, reply HEARTBEAT_OK.",
      `Tentacles active: ${tentacleCount}.`,
      `Pending reports: ${pendingReports}.`,
      `Workspace: ${this.piCtx.workspaceDir}.`,
    ]

    if (tentacles.length > 0) {
      parts.push(
        "Tentacle status summary:",
        ...tentacles.map((tentacle) => `- ${tentacle.tentacleId}: ${tentacle.status}, schedule=${tentacle.triggerSchedule ?? "-"}`),
      )
    }

    if (queuedEvents.length > 0) {
      parts.push(
        "Queued main-session cron system events:",
        ...queuedEvents.map((event, index) => `${index + 1}. ${event.text}`),
      )
    }

    const output = await this.brain.runHeartbeatTurn(parts.join("\n"))
    const result: HeartbeatResult = {
      action: output.text.trim() === "HEARTBEAT_OK" && output.toolCalls.length === 0 ? "ok" : "acted",
      tasksChecked: queuedEvents.length + tentacleCount,
      actionsPerformed: output.toolCalls.length,
      durationMs: Date.now() - startedAt,
    }

    brainLogger.info("heartbeat_result", {
      action: result.action,
      tasks_checked: result.tasksChecked,
      actions_performed: result.actionsPerformed,
      duration_ms: result.durationMs,
    })

    void this.memoryManager
    return result
  }
}
