import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { PushFeedbackTracker, detectFeedbackSignal } from "../../src/push/feedback-tracker.js"

describe("PushFeedbackTracker", () => {
  let dir: string
  let tracker: PushFeedbackTracker

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-fb-init-"))
    initLoggers({
      meta: { version: "3.2" },
      gateway: { port: 18790, bind: "loopback", auth: { mode: "token", token: "x" } },
      agents: { defaults: { workspace: tmpDir, model: { primary: "anthropic/claude-sonnet-4-5", fallbacks: [] }, userTimezone: "UTC", bootstrapMaxChars: 20000, bootstrapTotalMaxChars: 150000 } },
      models: { providers: {} },
      auth: { profiles: {}, order: {}, cooldown: "5m", cacheRetention: "long" },
      channels: { telegram: { enabled: false, dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled", streaming: true, ackReaction: { emoji: "🐙", direct: true }, textChunkLimit: 4000 }, feishu: { enabled: false, dmPolicy: "pairing", allowFrom: [], domain: "feishu", streaming: true, groupPolicy: "disabled" }, webchat: { enabled: true, port: 18791, auth: { mode: "token" } } },
      mcp: { servers: {}, webSearch: { cacheTtlMinutes: 15 }, webFetch: { maxCharsCap: 50000 } },
      skills: { paths: [] },
      tentacle: { maxActive: 20, ipcSocketPath: path.join(tmpDir, "sock"), codeGenMaxRetries: 3, crashRestartMaxAttempts: 3, confidenceThresholds: { directReport: 0.8, consultation: 0.4, discard: 0 } },
      push: { defaultTiming: "best_time", preferredWindowStart: "09:00", preferredWindowEnd: "10:00", maxDailyPushes: 5, consolidate: true, dedup: { byUrl: true, bySimilarity: true, similarityThreshold: 0.8 }, feedback: { enabled: true, ignoreWindowHours: 24 }, fallbackDigestTime: "09:00", fallbackDigestTz: "UTC" },
      session: { dmScope: "main", mainKey: "main", reset: { mode: "daily", atHour: 4 }, resetTriggers: ["/new"], cleanup: { maxArchiveFilesPerKey: 30, archiveTtlDays: 90, heartbeatRetentionDays: 7, consultationRetentionDays: 30 } },
      logging: { logDir: path.join(tmpDir, "logs"), level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
      cost: { dailyLimitUsd: 0.5, alertThresholdUsd: 0.4 },
      commands: { config: false, debug: false, bash: false },
      tools: { loopDetection: { enabled: true, warningThreshold: 10, criticalThreshold: 20, historySize: 30, detectors: { genericRepeat: true, knownPollNoProgress: true, pingPong: true } } },
    } as any)
  })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-fb-"))
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true })
    tracker = new PushFeedbackTracker(path.join(dir, "memory"), null)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("records and retrieves feedback", async () => {
    await tracker.recordFeedback({
      messageId: "msg1",
      sourceTentacles: ["t_news"],
      reaction: "positive",
      timestamp: new Date().toISOString(),
    })

    const rate = await tracker.getAdoptionRate("t_news")
    expect(rate).toBe(1)
  })

  it("calculates mixed adoption rate", async () => {
    await tracker.recordFeedback({
      messageId: "msg1",
      sourceTentacles: ["t_test"],
      reaction: "positive",
      timestamp: new Date().toISOString(),
    })
    await tracker.recordFeedback({
      messageId: "msg2",
      sourceTentacles: ["t_test"],
      reaction: "negative",
      timestamp: new Date().toISOString(),
    })
    await tracker.recordFeedback({
      messageId: "msg3",
      sourceTentacles: ["t_test"],
      reaction: "ignored",
      timestamp: new Date().toISOString(),
    })

    const rate = await tracker.getAdoptionRate("t_test")
    expect(rate).toBeCloseTo(1 / 3, 1)
  })

  it("returns neutral for unknown tentacle", async () => {
    const rate = await tracker.getAdoptionRate("t_unknown")
    expect(rate).toBe(0.5)
  })

  it("gets overall stats", async () => {
    await tracker.recordFeedback({
      messageId: "a",
      sourceTentacles: ["t_a"],
      reaction: "positive",
      timestamp: new Date().toISOString(),
    })
    await tracker.recordFeedback({
      messageId: "b",
      sourceTentacles: ["t_b"],
      reaction: "negative",
      timestamp: new Date().toISOString(),
    })

    const stats = await tracker.getStats()
    expect(stats.total).toBe(2)
    expect(stats.positive).toBe(1)
    expect(stats.negative).toBe(1)
    expect(stats.ignored).toBe(0)
  })
})

describe("detectFeedbackSignal", () => {
  it("detects positive signals", () => {
    expect(detectFeedbackSignal("Thanks, very helpful")).toBe("positive")
    expect(detectFeedbackSignal("Got it, thanks")).toBe("positive")
    expect(detectFeedbackSignal("Thanks!")).toBe("positive")
    expect(detectFeedbackSignal("👍")).toBe("positive")
  })

  it("detects negative signals", () => {
    expect(detectFeedbackSignal("Useless")).toBe("negative")
    expect(detectFeedbackSignal("Don't send this anymore")).toBe("negative")
    expect(detectFeedbackSignal("Stop sending")).toBe("negative")
    expect(detectFeedbackSignal("👎")).toBe("negative")
  })

  it("returns null for neutral messages", () => {
    expect(detectFeedbackSignal("Tell me more")).toBeNull()
    expect(detectFeedbackSignal("Hello")).toBeNull()
  })
})
