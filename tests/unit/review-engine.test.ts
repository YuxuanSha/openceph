import { describe, it, expect, beforeAll } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { TentacleReviewEngine } from "../../src/tentacle/review-engine.js"
import type { TentacleManager, TentacleStatus } from "../../src/tentacle/manager.js"
import type { TentacleHealthCalculator, HealthScore } from "../../src/tentacle/health-score.js"

function makeStatus(overrides: Partial<TentacleStatus>): TentacleStatus {
  return {
    tentacleId: "t_test",
    id: "t_test",
    triggerType: "schedule",
    status: "running",
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    totalReports: 5,
    totalFindings: 3,
    healthScore: 0.5,
    directory: "/tmp/t_test",
    ...overrides,
  }
}

function makeHealth(score: number, trend: HealthScore["trend"] = "stable"): HealthScore {
  return {
    score,
    components: { reportFrequency: score, avgQuality: score, adoptionRate: score },
    trend,
    lastCalculatedAt: new Date().toISOString(),
  }
}

function mockManager(tentacles: TentacleStatus[]): TentacleManager {
  return {
    listAll: () => tentacles,
  } as any
}

function mockHealthCalc(healthMap: Map<string, HealthScore>): TentacleHealthCalculator {
  return {
    calculateAll: async () => healthMap,
    calculate: async (id: string) => healthMap.get(id) ?? makeHealth(0),
  } as any
}

describe("TentacleReviewEngine", () => {
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-review-"))
    initLoggers({
      meta: { version: "3.2" },
      gateway: { port: 18790, bind: "loopback", auth: { mode: "token", token: "x" } },
      agents: { defaults: { workspace: dir, model: { primary: "anthropic/claude-sonnet-4-5", fallbacks: [] }, userTimezone: "UTC", bootstrapMaxChars: 20000, bootstrapTotalMaxChars: 150000 } },
      models: { providers: {} },
      auth: { profiles: {}, order: {}, cooldown: "5m", cacheRetention: "long" },
      channels: { telegram: { enabled: false, dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled", streaming: true, ackReaction: { emoji: "🐙", direct: true }, textChunkLimit: 4000 }, feishu: { enabled: false, dmPolicy: "pairing", allowFrom: [], domain: "feishu", streaming: true, groupPolicy: "disabled" }, webchat: { enabled: true, port: 18791, auth: { mode: "token" } } },
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

  it("recommends weaken for low-health running tentacle", async () => {
    const tentacles = [makeStatus({ tentacleId: "t_low", status: "running" })]
    const healthMap = new Map([["t_low", makeHealth(0.15)]])
    const engine = new TentacleReviewEngine(mockManager(tentacles), mockHealthCalc(healthMap))

    const actions = await engine.review()
    expect(actions).toHaveLength(1)
    expect(actions[0].action).toBe("weaken")
    expect(actions[0].requiresUserConfirm).toBe(false)
  })

  it("recommends kill for weakened tentacle with critical health", async () => {
    const tentacles = [makeStatus({ tentacleId: "t_weak", status: "weakened" })]
    const healthMap = new Map([["t_weak", makeHealth(0.05)]])
    const engine = new TentacleReviewEngine(mockManager(tentacles), mockHealthCalc(healthMap))

    const actions = await engine.review()
    expect(actions).toHaveLength(1)
    expect(actions[0].action).toBe("kill")
    expect(actions[0].requiresUserConfirm).toBe(true)
  })

  it("recommends strengthen for recovered weakened tentacle", async () => {
    const tentacles = [makeStatus({ tentacleId: "t_recovered", status: "weakened" })]
    const healthMap = new Map([["t_recovered", makeHealth(0.85)]])
    const engine = new TentacleReviewEngine(mockManager(tentacles), mockHealthCalc(healthMap))

    const actions = await engine.review()
    expect(actions).toHaveLength(1)
    expect(actions[0].action).toBe("strengthen")
    expect(actions[0].requiresUserConfirm).toBe(false)
  })

  it("recommends kill for 14-day silent tentacle", async () => {
    const staleDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
    const tentacles = [makeStatus({
      tentacleId: "t_silent",
      status: "running",
      lastReportAt: staleDate,
    })]
    const healthMap = new Map([["t_silent", makeHealth(0.5)]])
    const engine = new TentacleReviewEngine(mockManager(tentacles), mockHealthCalc(healthMap))

    const actions = await engine.review()
    expect(actions).toHaveLength(1)
    expect(actions[0].action).toBe("kill")
    expect(actions[0].requiresUserConfirm).toBe(true)
  })

  it("recommends merge for tentacles with similar purposes", async () => {
    const tentacles = [
      makeStatus({ tentacleId: "t_a", status: "running", purpose: "monitor product hunt launches daily" }),
      makeStatus({ tentacleId: "t_b", status: "running", purpose: "monitor product hunt new launches" }),
    ]
    const healthMap = new Map([
      ["t_a", makeHealth(0.6)],
      ["t_b", makeHealth(0.6)],
    ])
    const engine = new TentacleReviewEngine(mockManager(tentacles), mockHealthCalc(healthMap))

    const actions = await engine.review()
    const mergeAction = actions.find((a) => a.action === "merge")
    expect(mergeAction).toBeTruthy()
    expect(mergeAction!.requiresUserConfirm).toBe(true)
    expect(mergeAction!.mergeWith).toBeTruthy()
  })

  it("returns no actions for healthy tentacles", async () => {
    const tentacles = [
      makeStatus({ tentacleId: "t_ok", status: "running", purpose: "check weather" }),
    ]
    const healthMap = new Map([["t_ok", makeHealth(0.7)]])
    const engine = new TentacleReviewEngine(mockManager(tentacles), mockHealthCalc(healthMap))

    const actions = await engine.review()
    expect(actions).toHaveLength(0)
  })

  it("skips killed/crashed tentacles", async () => {
    const tentacles = [
      makeStatus({ tentacleId: "t_dead", status: "killed" }),
      makeStatus({ tentacleId: "t_crash", status: "crashed" }),
    ]
    const healthMap = new Map<string, HealthScore>()
    const engine = new TentacleReviewEngine(mockManager(tentacles), mockHealthCalc(healthMap))

    const actions = await engine.review()
    expect(actions).toHaveLength(0)
  })
})
