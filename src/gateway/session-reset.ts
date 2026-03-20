import cron from "node-cron"
import type { OpenCephConfig } from "../config/config-schema.js"
import { SessionStoreManager } from "../session/session-store.js"
import { gatewayLogger } from "../logger/index.js"

export class SessionResetScheduler {
  private dailyTask: cron.ScheduledTask | null = null
  private idleCheckTask: cron.ScheduledTask | null = null
  private sessionStore: SessionStoreManager

  constructor(
    private config: OpenCephConfig,
    sessionStore?: SessionStoreManager,
  ) {
    this.sessionStore = sessionStore ?? new SessionStoreManager("ceph")
  }

  start(): void {
    const { atHour } = this.config.session.reset

    // Daily reset at configured hour
    this.dailyTask = cron.schedule(`0 ${atHour} * * *`, async () => {
      gatewayLogger.info("session_reset_daily", { hour: atHour })
      try {
        const sessions = await this.sessionStore.list()
        for (const session of sessions) {
          await this.sessionStore.reset(session.sessionKey, "daily")
        }
      } catch (err: any) {
        gatewayLogger.error("session_reset_daily_error", { error: err.message })
      }
    })

    // Idle reset check every minute (if idleMinutes is configured)
    const idleMinutes = this.config.session.reset.idleMinutes
    if (idleMinutes) {
      this.idleCheckTask = cron.schedule("* * * * *", async () => {
        try {
          const sessions = await this.sessionStore.list()
          const cutoff = Date.now() - idleMinutes * 60 * 1000
          for (const session of sessions) {
            if (new Date(session.updatedAt).getTime() < cutoff) {
              gatewayLogger.info("session_reset_idle", {
                session_key: session.sessionKey,
                idle_minutes: idleMinutes,
              })
              await this.sessionStore.reset(session.sessionKey, "idle")
            }
          }
        } catch (err: any) {
          gatewayLogger.error("session_reset_idle_error", { error: err.message })
        }
      })
    }
  }

  stop(): void {
    this.dailyTask?.stop()
    this.idleCheckTask?.stop()
    this.dailyTask = null
    this.idleCheckTask = null
  }
}
