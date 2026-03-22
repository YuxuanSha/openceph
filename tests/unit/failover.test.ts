import { describe, it, expect, beforeAll } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { ModelFailover } from "../../src/brain/failover.js"

const minConfig = {
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["openai/gpt-4o"],
      },
    },
  },
} as any

describe("ModelFailover", () => {
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-fo-"))
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
      push: { defaultTiming: "best_time", preferredWindowStart: "09:00", preferredWindowEnd: "10:00", maxDailyPushes: 5, consolidate: true, dedup: { byUrl: true, bySimilarity: true, similarityThreshold: 0.8 }, feedback: { enabled: true, ignoreWindowHours: 24 }, fallbackDigestTime: "09:00", fallbackDigestTz: "UTC" },
      session: { dmScope: "main", mainKey: "main", reset: { mode: "daily", atHour: 4 }, resetTriggers: ["/new"], cleanup: { maxArchiveFilesPerKey: 30, archiveTtlDays: 90, heartbeatRetentionDays: 7, consultationRetentionDays: 30 } },
      logging: { logDir: path.join(dir, "logs"), level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
      cost: { dailyLimitUsd: 0.5, alertThresholdUsd: 0.4 },
      commands: { config: false, debug: false, bash: false },
      tools: { loopDetection: { enabled: true, warningThreshold: 10, criticalThreshold: 20, historySize: 30, detectors: { genericRepeat: true, knownPollNoProgress: true, pingPong: true } } },
    } as any)
  })

  it("returns ok for low token usage", () => {
    const failover = new ModelFailover(minConfig)
    const decision = failover.checkContextLimit(50_000, "anthropic/claude-sonnet-4-5")
    expect(decision.action).toBe("ok")
  })

  it("returns ok (warning) for moderate token usage", () => {
    const failover = new ModelFailover(minConfig)
    // 85-95% of 200K = 170K-190K
    const decision = failover.checkContextLimit(180_000, "anthropic/claude-sonnet-4-5")
    expect(decision.action).toBe("ok")
    expect(decision.reason).toContain("approaching")
  })

  it("suggests model switch at critical level when fallback has capacity", () => {
    // Use a config with a fallback that has a larger context window
    const configWithGemini = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-5",
            fallbacks: ["google/gemini-2.0-flash"],
          },
        },
      },
    } as any
    const failover = new ModelFailover(configWithGemini)
    // 95%+ of 200K = 190K+ but Gemini has 1M limit
    const decision = failover.checkContextLimit(195_000, "anthropic/claude-sonnet-4-5")
    expect(decision.action).toBe("switch")
    expect(decision.suggestedModel).toBe("google/gemini-2.0-flash")
  })

  it("suggests emergency compact when no fallback has capacity", () => {
    const failover = new ModelFailover(minConfig)
    // 95%+ of 200K with gpt-4o fallback (128K) → no fallback can help
    const decision = failover.checkContextLimit(195_000, "anthropic/claude-sonnet-4-5")
    expect(decision.action).toBe("emergency_compact")
  })

  it("switchToFallback returns next model", () => {
    const failover = new ModelFailover(minConfig)
    expect(failover.switchToFallback("anthropic/claude-sonnet-4-5")).toBe("openai/gpt-4o")
  })

  it("switchToFallback returns null for last model", () => {
    const failover = new ModelFailover(minConfig)
    expect(failover.switchToFallback("openai/gpt-4o")).toBeNull()
  })

  it("uses default limit for unknown models", () => {
    const failover = new ModelFailover(minConfig)
    expect(failover.getContextLimit("unknown/model")).toBe(128_000)
  })
})
