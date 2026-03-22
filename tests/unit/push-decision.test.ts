import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { OutboundQueue, type ApprovedPushItem } from "../../src/push/outbound-queue.js"
import { PushDecisionEngine } from "../../src/push/push-decision.js"

function makeItem(overrides: Partial<ApprovedPushItem> = {}): ApprovedPushItem {
  return {
    itemId: `item_${Math.random().toString(36).slice(2)}`,
    tentacleId: "t_test",
    content: "Push content",
    originalItems: [],
    priority: "normal",
    timelinessHint: "today",
    needsUserAction: false,
    approvedAt: new Date().toISOString(),
    status: "pending",
    ...overrides,
  }
}

const minConfig = {
  push: {
    defaultTiming: "best_time",
    preferredWindowStart: "09:00",
    preferredWindowEnd: "10:00",
    maxDailyPushes: 3,
    consolidate: true,
    dedup: { byUrl: true, bySimilarity: true, similarityThreshold: 0.8 },
    feedback: { enabled: true, ignoreWindowHours: 24 },
    fallbackDigestTime: "09:00",
    fallbackDigestTz: "UTC",
  },
} as any

describe("PushDecisionEngine", () => {
  let dir: string
  let queue: OutboundQueue
  let engine: PushDecisionEngine

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-pd-init-"))
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
      push: minConfig.push,
      session: { dmScope: "main", mainKey: "main", reset: { mode: "daily", atHour: 4 }, resetTriggers: ["/new"], cleanup: { maxArchiveFilesPerKey: 30, archiveTtlDays: 90, heartbeatRetentionDays: 7, consultationRetentionDays: 30 } },
      logging: { logDir: path.join(tmpDir, "logs"), level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
      cost: { dailyLimitUsd: 0.5, alertThresholdUsd: 0.4 },
      commands: { config: false, debug: false, bash: false },
      tools: { loopDetection: { enabled: true, warningThreshold: 10, criticalThreshold: 20, historySize: 30, detectors: { genericRepeat: true, knownPollNoProgress: true, pingPong: true } } },
    } as any)
  })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-pd-"))
    queue = new OutboundQueue(path.join(dir, "outbound.json"))
    engine = new PushDecisionEngine(minConfig, queue)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("returns shouldPush=false when queue is empty", async () => {
    const decision = await engine.evaluate({ type: "user_message", lastInteractionAt: new Date().toISOString() })
    expect(decision.shouldPush).toBe(false)
    expect(decision.reason).toBe("queue_empty")
  })

  it("pushes on user_message when items pending", async () => {
    await queue.addApprovedItem(makeItem())
    const decision = await engine.evaluate({ type: "user_message", lastInteractionAt: new Date().toISOString() })
    expect(decision.shouldPush).toBe(true)
    expect(decision.reason).toBe("user_message_piggyback")
    expect(decision.items).toHaveLength(1)
  })

  it("always pushes items needing user action", async () => {
    await queue.addApprovedItem(makeItem({ needsUserAction: true }))
    const decision = await engine.evaluate({ type: "heartbeat" })
    expect(decision.shouldPush).toBe(true)
    expect(decision.reason).toBe("user_action_required")
  })

  it("pushes urgent items on urgent trigger", async () => {
    await queue.addApprovedItem(makeItem({ priority: "urgent" }))
    const decision = await engine.evaluate({ type: "urgent_report", tentacleId: "t_test" })
    expect(decision.shouldPush).toBe(true)
    expect(decision.reason).toBe("urgent_report")
  })

  it("waits for better timing on heartbeat with few items", async () => {
    await queue.addApprovedItem(makeItem())
    const decision = await engine.evaluate({ type: "heartbeat" })
    expect(decision.shouldPush).toBe(false)
    expect(decision.reason).toBe("waiting_for_better_timing")
  })

  it("pushes on heartbeat when ≥3 items", async () => {
    await queue.addApprovedItem(makeItem({ itemId: "a", content: "First unique item about news" }))
    await queue.addApprovedItem(makeItem({ itemId: "b", content: "Second unique item about weather" }))
    await queue.addApprovedItem(makeItem({ itemId: "c", content: "Third unique item about stocks" }))
    const decision = await engine.evaluate({ type: "heartbeat" })
    expect(decision.shouldPush).toBe(true)
    expect(decision.reason).toBe("batch_threshold_reached")
  })

  it("pushes on heartbeat when oldest > 24h", async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    await queue.addApprovedItem(makeItem({ approvedAt: oldDate }))
    const decision = await engine.evaluate({ type: "daily_review" })
    expect(decision.shouldPush).toBe(true)
    expect(decision.reason).toBe("age_fallback_24h")
  })

  it("respects daily push limit", async () => {
    for (let i = 0; i < 3; i++) {
      await queue.addApprovedItem(makeItem({ itemId: `item${i}` }))
      const d = await engine.evaluate({ type: "user_message", lastInteractionAt: new Date().toISOString() })
      if (d.shouldPush) engine.recordPush()
    }

    await queue.addApprovedItem(makeItem())
    const decision = await engine.evaluate({ type: "user_message", lastInteractionAt: new Date().toISOString() })
    expect(decision.shouldPush).toBe(false)
    expect(decision.reason).toBe("daily_limit_reached")
  })

  it("consolidates multi-item push text", async () => {
    await queue.addApprovedItem(makeItem({ itemId: "a", tentacleId: "t_news", content: "Breaking news about AI startup" }))
    await queue.addApprovedItem(makeItem({ itemId: "b", tentacleId: "t_news", content: "Product Hunt top launch today" }))
    await queue.addApprovedItem(makeItem({ itemId: "c", tentacleId: "t_weather", content: "Weather forecast sunny for weekend" }))

    const decision = await engine.evaluate({ type: "user_message", lastInteractionAt: new Date().toISOString() })
    expect(decision.shouldPush).toBe(true)
    expect(decision.consolidatedText).toBeTruthy()
    expect(decision.items.length).toBeGreaterThanOrEqual(2)
  })
})
