import * as crypto from "crypto"
import type { PiContext } from "../pi/pi-context.js"
import { resolveRunnableModel } from "../pi/model-resolver.js"
import type { OpenCephConfig } from "../config/config-schema.js"
import type { Brain } from "../brain/brain.js"
import type { Gateway } from "../gateway/gateway.js"
import { SessionStoreManager } from "../session/session-store.js"
import type { CronJob, CronRunEntry, CronSystemEvent } from "./cron-types.js"
import { CronStore } from "./cron-store.js"
import { brainLogger, costLogger } from "../logger/index.js"
import { gatewayLogger } from "../logger/gateway-logger.js"

export class CronRunner {
  private wakeMainSession?: () => Promise<void>

  constructor(
    private piCtx: PiContext,
    private config: OpenCephConfig,
    private brain: Brain,
    private gateway: Gateway | null,
    private cronStore: CronStore,
    private sessionStore: SessionStoreManager,
  ) {}

  setWakeMainSession(fn: () => Promise<void>): void {
    this.wakeMainSession = fn
  }

  async runMainSession(job: CronJob): Promise<CronRunEntry> {
    const entry: CronRunEntry = {
      runId: crypto.randomUUID(),
      jobId: job.jobId,
      startedAt: new Date().toISOString(),
      status: "running",
    }

    try {
      const text = job.payload.kind === "systemEvent"
        ? job.payload.text
        : job.payload.message
      const event: CronSystemEvent = {
        id: crypto.randomUUID(),
        jobId: job.jobId,
        text,
        queuedAt: new Date().toISOString(),
        wakeMode: job.wakeMode,
      }
      await this.cronStore.appendSystemEvent(event)
      if (job.wakeMode === "now" && this.wakeMainSession) {
        await this.wakeMainSession()
      }
      entry.status = "success"
      entry.endedAt = new Date().toISOString()
      return entry
    } catch (error: any) {
      entry.status = "failed"
      entry.error = error.message
      entry.endedAt = new Date().toISOString()
      return entry
    }
  }

  async runIsolatedSession(job: CronJob): Promise<CronRunEntry> {
    const startedAt = new Date().toISOString()
    const resolution = resolveRunnableModel({
      piCtx: this.piCtx,
      config: this.config,
      preferredModel: job.model ?? this.config.heartbeat.model,
    })
    const model = resolution.modelId
    brainLogger.info("cron_job_start", {
      job_id: job.jobId,
      name: job.name,
      session_target: job.sessionTarget,
      model,
      model_source: resolution.source,
      fallback_reasons: resolution.reasons.length > 0 ? resolution.reasons : undefined,
    })

    if (job.tentacleId) {
      const success = job.jobId.startsWith("thb-")
        ? await this.brain.triggerTentacleHeartbeat(job.tentacleId, job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text, job.jobId)
        : await this.brain.triggerTentacleCron(job.tentacleId, job.jobId)
      const endedAt = new Date().toISOString()
      return {
        runId: crypto.randomUUID(),
        jobId: job.jobId,
        startedAt,
        endedAt,
        status: success ? "success" : "failed",
        error: success ? undefined : "Tentacle trigger failed",
      }
    }

    const maintenanceOutput = await this.runMaintenanceJob(job)
    const output = maintenanceOutput ?? await this.brain.runIsolatedTurn({
      sessionKey: job.sessionTarget.startsWith("session:") ? job.sessionTarget.slice("session:".length) : `cron:${job.jobId}`,
      message: `[cron:${job.jobId} ${job.name}] ${job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text}`,
      model,
      mode: job.payload.kind === "agentTurn" && job.payload.lightContext ? "minimal" : "full",
      thinking: job.thinking,
    })

    if (job.delivery?.mode === "announce" && output.text.trim() !== "HEARTBEAT_OK") {
      const target = this.brain.getLastActiveTarget(job.delivery.channel ?? "last")
      if (target && this.gateway) {
        await this.gateway.deliverToUser(target, {
          text: output.text,
          timing: "immediate",
          priority: "normal",
          messageId: crypto.randomUUID(),
        })
        gatewayLogger.info("cron_delivery_announce", { job_id: job.jobId, channel: target.channel })
      }
    } else if (job.delivery?.mode === "webhook" && job.delivery.to && output.text.trim() !== "HEARTBEAT_OK") {
      const response = await fetch(job.delivery.to, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: job.jobId,
          name: job.name,
          content: output.text,
          status: output.errorMessage ? "failed" : "success",
        }),
      })
      if (!response.ok) {
        gatewayLogger.error("cron_delivery_failed", { job_id: job.jobId, status: response.status })
        throw new Error(`Webhook delivery failed: ${response.status}`)
      }
    }

    const endedAt = new Date().toISOString()
    const entry: CronRunEntry = {
      runId: crypto.randomUUID(),
      jobId: job.jobId,
      startedAt,
      endedAt,
      status: output.errorMessage ? "failed" : "success",
      error: output.errorMessage,
      tokensUsed: { input: output.inputTokens, output: output.outputTokens },
    }

    brainLogger.info("cron_job_end", {
      job_id: job.jobId,
      status: entry.status,
      input_tokens: output.inputTokens,
      output_tokens: output.outputTokens,
    })
    costLogger.info("cron_job_cost", {
      job_id: job.jobId,
      model,
      input_tokens: output.inputTokens,
      output_tokens: output.outputTokens,
    })
    void this.piCtx
    void this.sessionStore
    return entry
  }

  private async runMaintenanceJob(job: CronJob) {
    if (job.jobId === "daily-review") {
      const text = await this.brain.runDailyReviewAutomation()
      return {
        text,
        errorMessage: undefined,
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: "system",
        durationMs: 0,
      }
    }
    if (job.jobId === "morning-digest-fallback") {
      const text = await this.brain.runMorningDigestFallback()
      return {
        text,
        errorMessage: undefined,
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: "system",
        durationMs: 0,
      }
    }
    return null
  }
}
