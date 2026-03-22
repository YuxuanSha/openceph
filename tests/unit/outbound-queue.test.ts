import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { OutboundQueue, type ApprovedPushItem } from "../../src/push/outbound-queue.js"

function makeItem(overrides: Partial<ApprovedPushItem> = {}): ApprovedPushItem {
  return {
    itemId: `item_${Math.random().toString(36).slice(2)}`,
    tentacleId: "t_test",
    content: "Test push content",
    originalItems: ["c1"],
    priority: "normal",
    timelinessHint: "today",
    needsUserAction: false,
    approvedAt: new Date().toISOString(),
    status: "pending",
    ...overrides,
  }
}

describe("OutboundQueue", () => {
  let dir: string
  let queue: OutboundQueue

  beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-oq-init-"))
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-oq-"))
    queue = new OutboundQueue(path.join(dir, "outbound.json"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("starts empty", async () => {
    const pending = await queue.getPending()
    expect(pending).toHaveLength(0)
    expect(await queue.pendingCount()).toBe(0)
  })

  it("adds and retrieves items", async () => {
    await queue.addApprovedItem(makeItem({ itemId: "a" }))
    await queue.addApprovedItem(makeItem({ itemId: "b" }))

    const pending = await queue.getPending()
    expect(pending).toHaveLength(2)
  })

  it("marks items as sent", async () => {
    await queue.addApprovedItem(makeItem({ itemId: "x" }))
    await queue.markSent("x")

    const pending = await queue.getPending()
    expect(pending).toHaveLength(0)

    const all = await queue.getAll()
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe("sent")
    expect(all[0].sentAt).toBeTruthy()
  })

  it("marks batch as sent", async () => {
    await queue.addApprovedItem(makeItem({ itemId: "a" }))
    await queue.addApprovedItem(makeItem({ itemId: "b" }))
    await queue.addApprovedItem(makeItem({ itemId: "c" }))

    await queue.markSentBatch(["a", "c"])

    const pending = await queue.getPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].itemId).toBe("b")
  })

  it("cleans up old sent items", async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    await queue.addApprovedItem(makeItem({ itemId: "old", status: "sent", sentAt: oldDate }))
    await queue.addApprovedItem(makeItem({ itemId: "new" }))

    const removed = await queue.cleanup(7)
    expect(removed).toBe(1)

    const all = await queue.getAll()
    expect(all).toHaveLength(1)
    expect(all[0].itemId).toBe("new")
  })

  it("stores and retrieves deferred messages separately from approved pushes", async () => {
    await queue.addApprovedItem(makeItem({ itemId: "push-1" }))
    await queue.addDeferredMessage({
      messageId: "deferred-1",
      message: "digest later",
      channel: "telegram",
      senderId: "user-1",
      timing: "morning_digest",
      priority: "normal",
      source: "consultation_session",
      targetSessionKey: "agent:ceph:main",
      tentacleId: "t_digest",
    })

    const pendingApproved = await queue.getPending()
    const pendingDeferred = await queue.getPendingDeferred()

    expect(pendingApproved).toHaveLength(1)
    expect(pendingApproved[0].itemId).toBe("push-1")
    expect(pendingDeferred).toHaveLength(1)
    expect(pendingDeferred[0].messageId).toBe("deferred-1")
  })
})
