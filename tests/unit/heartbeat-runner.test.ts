import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { initLoggers } from "../../src/logger/index.js"
import { HeartbeatRunner } from "../../src/heartbeat/heartbeat-runner.js"

describe("HeartbeatRunner", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-heartbeat-runner-"))
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true })
    initLoggers({
      meta: { version: "3.2" },
      gateway: { port: 18790, bind: "loopback", auth: { mode: "token", token: "x" } },
      agents: { defaults: { workspace: path.join(dir, "workspace"), model: { primary: "anthropic/claude-sonnet-4-5", fallbacks: [] }, userTimezone: "UTC", bootstrapMaxChars: 20000, bootstrapTotalMaxChars: 150000 } },
      models: { providers: {} },
      auth: { profiles: {}, order: {}, cooldown: "5m", cacheRetention: "long" },
      channels: { telegram: { enabled: false, dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled", streaming: true, ackReaction: { emoji: "x", direct: true }, textChunkLimit: 4000 }, feishu: { enabled: false, dmPolicy: "pairing", allowFrom: [], domain: "feishu", streaming: true, groupPolicy: "disabled" }, webchat: { enabled: true, port: 18791, auth: { mode: "token" } } },
      mcp: { servers: {}, webSearch: { cacheTtlMinutes: 15 }, webFetch: { maxCharsCap: 50000 } },
      skills: { paths: [] },
      tentacle: { maxActive: 20, ipcSocketPath: path.join(dir, "sock"), codeGenMaxRetries: 3, crashRestartMaxAttempts: 3, confidenceThresholds: { directReport: 0.8, consultation: 0.4, discard: 0 } },
      push: { defaultTiming: "best_time", preferredWindowStart: "09:00", preferredWindowEnd: "10:00", maxDailyPushes: 3 },
      session: { dmScope: "main", mainKey: "main", reset: { mode: "daily", atHour: 4 }, resetTriggers: ["/new"], cleanup: { maxArchiveFilesPerKey: 30, archiveTtlDays: 90, heartbeatRetentionDays: 7, consultationRetentionDays: 30 } },
      logging: { logDir: path.join(dir, "logs"), level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
      cost: { dailyLimitUsd: 0.5, alertThresholdUsd: 0.4 },
      commands: { config: false, debug: false, bash: false },
      tools: { loopDetection: { enabled: true, warningThreshold: 10, criticalThreshold: 20, historySize: 30, detectors: { genericRepeat: true, knownPollNoProgress: true, pingPong: true } } },
    } as any)
  })

  afterEach(() => {
    // Logger transports may still flush asynchronously after the assertion completes.
    // Keep the temp directory to avoid false-positive ENOENT errors from file transports.
  })

  it("includes tentacle status and pending reports in heartbeat prompt", async () => {
    const runHeartbeatTurn = vi.fn().mockResolvedValue({ text: "HEARTBEAT_OK", toolCalls: [] })
    const runner = new HeartbeatRunner(
      { workspaceDir: path.join(dir, "workspace") } as any,
      {} as any,
      {
        getPendingReportCount: vi.fn().mockResolvedValue(2),
        runHeartbeatTurn,
      } as any,
      {
        listAll: vi.fn().mockReturnValue([
          {
            tentacleId: "t1",
            status: "running",
            triggerSchedule: "every 10m",
          },
        ]),
      } as any,
      {} as any,
      {
        drainPendingSystemEvents: vi.fn().mockResolvedValue([{ text: "daily review due" }]),
      } as any,
    )

    const result = await runner.runHeartbeat()

    expect(result.action).toBe("ok")
    expect(result.tasksChecked).toBe(2)
    expect(runHeartbeatTurn).toHaveBeenCalledTimes(1)
    expect(runHeartbeatTurn.mock.calls[0][0]).toContain("Pending reports: 2.")
    expect(runHeartbeatTurn.mock.calls[0][0]).toContain("- t1: running, schedule=every 10m")
    expect(runHeartbeatTurn.mock.calls[0][0]).toContain("daily review due")
  })
})
