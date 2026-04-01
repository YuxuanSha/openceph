import * as crypto from "crypto"
import cron from "node-cron"
import type { ScheduledTask } from "node-cron"
import type { OpenCephConfig } from "../config/config-schema.js"
import { CronStore } from "./cron-store.js"
import { CronRunner } from "./cron-runner.js"
import type { CronAddParams, CronJob, CronRunEntry, CronSystemEvent } from "./cron-types.js"
import { formatIso, parseAtTime } from "./time.js"
import { brainLogger } from "../logger/index.js"

type TimerHandle = NodeJS.Timeout | ScheduledTask

export class CronScheduler {
  private jobs: Map<string, CronJob> = new Map()
  private timers: Map<string, TimerHandle> = new Map()
  private activeRuns = 0
  private waiters: Array<() => void> = []

  constructor(
    private config: OpenCephConfig,
    private cronStore: CronStore,
    private cronRunner: CronRunner,
  ) {}

  async start(): Promise<void> {
    const jobs = ensureDefaultJobs(await this.cronStore.loadAll(), this.config)
    await this.cronStore.saveAll(jobs)

    for (const job of jobs) {
      this.jobs.set(job.jobId, job)
      if (job.enabled) {
        this.scheduleJob(job)
      }
    }
  }

  stop(): void {
    for (const handle of this.timers.values()) {
      if (typeof (handle as ScheduledTask).stop === "function") {
        ;(handle as ScheduledTask).stop()
      } else {
        clearTimeout(handle as NodeJS.Timeout)
        clearInterval(handle as NodeJS.Timeout)
      }
    }
    this.timers.clear()
  }

  async addJob(params: CronAddParams): Promise<CronJob> {
    const now = new Date().toISOString()
    const job: CronJob = {
      jobId: params.jobId ?? slugify(params.name),
      name: params.name,
      description: params.description,
      schedule: params.schedule,
      sessionTarget: params.sessionTarget,
      wakeMode: params.wakeMode ?? "next-heartbeat",
      payload: params.payload,
      delivery: params.delivery,
      model: params.model,
      thinking: params.thinking,
      enabled: params.enabled ?? true,
      deleteAfterRun: params.deleteAfterRun ?? params.schedule.kind === "at",
      createdAt: now,
      tentacleId: params.tentacleId,
    }

    this.jobs.set(job.jobId, job)
    await this.persist()
    if (job.enabled) {
      this.scheduleJob(job)
    }
    return job
  }

  async updateJob(jobId: string, patch: Partial<CronJob>): Promise<CronJob> {
    const current = this.jobs.get(jobId)
    if (!current) throw new Error(`Cron job not found: ${jobId}`)
    const next = { ...current, ...patch, jobId: current.jobId }
    this.jobs.set(jobId, next)
    this.unscheduleJob(jobId)
    if (next.enabled) {
      this.scheduleJob(next)
    }
    await this.persist()
    return next
  }

  async removeJob(jobId: string): Promise<boolean> {
    const existed = this.jobs.delete(jobId)
    this.unscheduleJob(jobId)
    await this.persist()
    return existed
  }

  async runJob(jobId: string, mode: "force" | "due" = "force"): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`Cron job not found: ${jobId}`)
    if (mode === "due" && !job.enabled) return
    await this.acquireSlot()
    try {
      const entry = await this.executeWithRetry(job)
      await this.recordRun(job, entry)
    } finally {
      this.releaseSlot()
    }
  }

  listJobs(filter?: { enabled?: boolean }): CronJob[] {
    return Array.from(this.jobs.values())
      .filter((job) => filter?.enabled === undefined ? true : job.enabled === filter.enabled)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async getRunHistory(jobId: string, limit = 20): Promise<CronRunEntry[]> {
    return this.cronStore.getRunEntries(jobId, limit)
  }

  async injectSystemEvent(text: string, wakeMode: "now" | "next-heartbeat"): Promise<void> {
    const event: CronSystemEvent = {
      id: crypto.randomUUID(),
      jobId: "manual",
      text,
      queuedAt: new Date().toISOString(),
      wakeMode,
    }
    await this.cronStore.appendSystemEvent(event)
  }

  async drainPendingSystemEvents(): Promise<CronSystemEvent[]> {
    const events = await this.cronStore.readSystemEvents()
    await this.cronStore.clearSystemEvents()
    return events
  }

  getJob(jobId: string): CronJob | undefined {
    return this.jobs.get(jobId)
  }

  private scheduleJob(job: CronJob): void {
    this.unscheduleJob(job.jobId)

    if (job.schedule.kind === "cron") {
      const task = cron.schedule(job.schedule.expr, () => {
        void this.runJob(job.jobId, "due")
      }, {
        timezone: job.schedule.tz ?? this.config.cron.timezone,
      })
      this.timers.set(job.jobId, task)
      job.nextRunAt = formatIso(task.getNextRun())
      return
    }

    if (job.schedule.kind === "every") {
      const handle = setInterval(() => {
        void this.runJob(job.jobId, "due")
      }, job.schedule.everyMs)
      this.timers.set(job.jobId, handle)
      job.nextRunAt = new Date(Date.now() + job.schedule.everyMs).toISOString()
      return
    }

    const at = parseAtTime(job.schedule.at)
    const delay = Math.max(0, at.getTime() - Date.now())
    const handle = setTimeout(() => {
      void this.runJob(job.jobId, "due")
    }, delay)
    this.timers.set(job.jobId, handle)
    job.nextRunAt = at.toISOString()
  }

  private unscheduleJob(jobId: string): void {
    const handle = this.timers.get(jobId)
    if (!handle) return
    if (typeof (handle as ScheduledTask).stop === "function") {
      ;(handle as ScheduledTask).stop()
    } else {
      clearTimeout(handle as NodeJS.Timeout)
      clearInterval(handle as NodeJS.Timeout)
    }
    this.timers.delete(jobId)
  }

  private async recordRun(job: CronJob, entry: CronRunEntry): Promise<void> {
    job.lastRunAt = entry.endedAt ?? new Date().toISOString()
    if (job.schedule.kind === "every") {
      job.nextRunAt = new Date(Date.now() + job.schedule.everyMs).toISOString()
    } else if (job.schedule.kind === "cron") {
      const task = this.timers.get(job.jobId) as ScheduledTask | undefined
      job.nextRunAt = formatIso(task?.getNextRun?.())
    } else {
      job.nextRunAt = undefined
      if (job.deleteAfterRun) {
        await this.removeJob(job.jobId)
      }
    }

    await this.cronStore.appendRunEntry(job.jobId, entry)
    await this.cronStore.pruneRunLogs(this.config.cron.runLog)
    await this.cronStore.pruneIsolatedSessions(this.config.cron.isolatedSessionRetention)
    await this.persist()
  }

  private async persist(): Promise<void> {
    await this.cronStore.saveAll(this.listJobs())
  }

  private async executeWithRetry(job: CronJob): Promise<CronRunEntry> {
    const maxAttempts = Math.max(1, this.config.cron.retry.maxAttempts)
    let attempt = 0
    let lastEntry: CronRunEntry | null = null
    while (attempt < maxAttempts) {
      attempt++
      try {
        const entry = job.sessionTarget === "main"
          ? await this.cronRunner.runMainSession(job)
          : await this.cronRunner.runIsolatedSession(job)
        if (entry.status !== "failed") {
          return entry
        }
        lastEntry = entry
        const permanent = isPermanentError(entry.error)
        brainLogger.error("cron_job_failed", { job_id: job.jobId, error: entry.error, retry_attempt: attempt, permanent })
        if (permanent) {
          if (job.schedule.kind === "at") {
            job.enabled = false
          }
          return entry
        }
      } catch (error: any) {
        lastEntry = {
          runId: crypto.randomUUID(),
          jobId: job.jobId,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          status: "failed",
          error: error.message,
        }
        brainLogger.error("cron_job_failed", { job_id: job.jobId, error: error.message, retry_attempt: attempt, permanent: false })
      }
      if (attempt < maxAttempts) {
        const backoff = this.config.cron.retry.backoffMs[Math.min(attempt - 1, this.config.cron.retry.backoffMs.length - 1)] ?? 60_000
        await new Promise((resolve) => setTimeout(resolve, backoff))
      }
    }
    return lastEntry ?? {
      runId: crypto.randomUUID(),
      jobId: job.jobId,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: "failed",
      error: "Unknown cron failure",
    }
  }

  private async acquireSlot(): Promise<void> {
    const max = Math.max(1, this.config.cron.maxConcurrentRuns)
    if (this.activeRuns < max) {
      this.activeRuns++
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.activeRuns++
        resolve()
      })
    })
  }

  private releaseSlot(): void {
    this.activeRuns = Math.max(0, this.activeRuns - 1)
    const next = this.waiters.shift()
    next?.()
  }
}

function createDefaultDailyReview(timezone: string): CronJob {
  return {
    jobId: "daily-review",
    name: "Daily Review",
    schedule: { kind: "cron", expr: "0 22 * * *", tz: timezone },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message: "Execute daily review:\n1. Read HEARTBEAT.md task list and execute all items\n2. list_tentacles() — evaluate health, weaken or kill inactive ones\n3. Process pending reports queue — decide send or discard\n4. distill_memory() — distill today's memory log to MEMORY.md\n5. Evaluate whether new tentacles are needed\n6. Mark completed tasks in HEARTBEAT.md\nIf nothing needs attention, reply HEARTBEAT_OK.",
    },
    delivery: { mode: "announce", channel: "last" },
    enabled: true,
    deleteAfterRun: false,
    createdAt: new Date().toISOString(),
    nextRunAt: undefined,
  }
}

function createMorningDigestFallback(timezone: string, time: string): CronJob {
  const [hour = "9", minute = "0"] = time.split(":")
  return {
    jobId: "morning-digest-fallback",
    name: "Morning Digest Fallback",
    schedule: { kind: "cron", expr: `${Number(minute)} ${Number(hour)} * * *`, tz: timezone },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message: "Check outbound queue. If any items older than 24h remain unsent, consolidate and push now. Otherwise reply HEARTBEAT_OK.",
    },
    delivery: { mode: "announce", channel: "last" },
    enabled: true,
    deleteAfterRun: false,
    createdAt: new Date().toISOString(),
    nextRunAt: undefined,
  }
}

function ensureDefaultJobs(existing: CronJob[], config: OpenCephConfig): CronJob[] {
  const jobs = [...existing]
  if (!jobs.some((job) => job.jobId === "daily-review")) {
    jobs.push(createDefaultDailyReview(config.cron.timezone))
  }
  if (!jobs.some((job) => job.jobId === "morning-digest-fallback")) {
    jobs.push(createMorningDigestFallback(config.push.fallbackDigestTz, config.push.fallbackDigestTime))
  }
  return jobs
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return base || crypto.randomUUID()
}

function isPermanentError(error?: string): boolean {
  const text = (error ?? "").toLowerCase()
  return text.includes("401") || text.includes("403") || text.includes("config") || text.includes("credential") || text.includes("not found: model")
}
