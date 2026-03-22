import type { OpenCephConfig } from "../config/config-schema.js"
import type { Brain } from "../brain/brain.js"
import type { TentacleManager } from "../tentacle/manager.js"
import type { HeartbeatRunner } from "./heartbeat-runner.js"
import { brainLogger } from "../logger/index.js"
import { isWithinActiveHours, parseDurationMs } from "../cron/time.js"

export class HeartbeatScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private config: OpenCephConfig,
    private brain: Brain,
    private tentacleManager: TentacleManager | null,
    private runner: HeartbeatRunner,
  ) {}

  start(): void {
    this.stop()
    const intervalMs = parseDurationMs(this.config.heartbeat.every)
    this.timer = setInterval(() => {
      void this.executeScheduled()
    }, intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async triggerNow(): Promise<void> {
    await this.executeScheduled(true)
  }

  private async executeScheduled(force = false): Promise<void> {
    if (this.running) return
    const now = new Date()
    if (!force && !isWithinActiveHours(now, this.config.heartbeat.activeHours)) {
      brainLogger.info("heartbeat_skipped_outside_hours", {
        at: now.toISOString(),
      })
      return
    }

    this.running = true
    brainLogger.info("heartbeat_start", {
      interval: this.config.heartbeat.every,
      tentacles: this.tentacleManager?.listAll().length ?? 0,
    })
    try {
      await this.runner.runHeartbeat()
      void this.brain
    } finally {
      brainLogger.info("heartbeat_end", { at: new Date().toISOString() })
      this.running = false
    }
  }
}
