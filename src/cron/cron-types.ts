export type CronSessionTarget = "main" | "isolated" | `session:${string}`
export type CronWakeMode = "now" | "next-heartbeat"

export interface CronJob {
  jobId: string
  name: string
  description?: string
  schedule: CronSchedule
  sessionTarget: CronSessionTarget
  wakeMode: CronWakeMode
  payload: CronPayload
  delivery?: CronDelivery
  model?: string
  thinking?: string
  enabled: boolean
  deleteAfterRun: boolean
  createdAt: string
  lastRunAt?: string
  nextRunAt?: string
  tentacleId?: string
}

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | { kind: "agentTurn"; message: string; lightContext?: boolean }

export interface CronDelivery {
  mode: "announce" | "webhook" | "none"
  channel?: string
  to?: string
  bestEffort?: boolean
}

export interface CronRunEntry {
  runId: string
  jobId: string
  startedAt: string
  endedAt?: string
  status: "running" | "success" | "failed" | "skipped"
  error?: string
  tokensUsed?: { input: number; output: number }
  costUsd?: number
}

export interface CronSystemEvent {
  id: string
  jobId: string
  text: string
  queuedAt: string
  wakeMode: CronWakeMode
}

export interface CronAddParams {
  jobId?: string
  name: string
  description?: string
  schedule: CronSchedule
  sessionTarget: CronSessionTarget
  wakeMode?: CronWakeMode
  payload: CronPayload
  delivery?: CronDelivery
  model?: string
  thinking?: string
  enabled?: boolean
  deleteAfterRun?: boolean
  tentacleId?: string
}
