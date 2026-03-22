export interface TentacleScheduleConfig {
  primaryTrigger: TentacleTrigger
  heartbeat?: {
    enabled: boolean
    every: string
    prompt: string
    jobId?: string
  }
  cronJobs?: string[]
}

export type TentacleTrigger =
  | { type: "self-schedule"; interval: string }
  | { type: "cron"; jobId: string }
  | { type: "heartbeat-driven" }
