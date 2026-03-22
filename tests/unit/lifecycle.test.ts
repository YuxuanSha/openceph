import { describe, it, expect, vi, beforeAll } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { TentacleLifecycleManager } from "../../src/tentacle/lifecycle.js"
import type { TentacleManager } from "../../src/tentacle/manager.js"
import type { TentacleRegistry } from "../../src/tentacle/registry.js"
import type { TentacleHealthCalculator } from "../../src/tentacle/health-score.js"
import type { CodeAgent } from "../../src/code-agent/code-agent.js"

function mockManager(): TentacleManager {
  return {
    getTentacleBaseDir: () => "/tmp/test-lifecycle",
    getTentacleDir: (id: string) => `/tmp/test-lifecycle/${id}`,
    getTentacleSchedule: vi.fn().mockResolvedValue({
      primaryTrigger: { type: "self-schedule", interval: "6h" },
      cronJobs: [],
    }),
    setTentacleSchedule: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({
      tentacleId: "t_test",
      status: "running",
      purpose: "test",
      runtime: "python",
    }),
    listAll: vi.fn().mockReturnValue([]),
    kill: vi.fn().mockResolvedValue(true),
    spawn: vi.fn().mockResolvedValue(undefined),
    waitForRegistration: vi.fn().mockResolvedValue(true),
  } as any
}

function mockRegistry(): TentacleRegistry {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
  } as any
}

function mockHealthCalc(): TentacleHealthCalculator {
  return {} as any
}

function mockCodeAgent(): CodeAgent {
  return {} as any
}

describe("TentacleLifecycleManager", () => {
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-lifecycle-"))
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

  it("weaken auto-downgrades from 6h to 12h", async () => {
    const mgr = mockManager()
    const registry = mockRegistry()
    const lifecycle = new TentacleLifecycleManager(mgr, null, mockCodeAgent(), registry, mockHealthCalc())

    await lifecycle.weaken("t_test")

    expect(mgr.setTentacleSchedule).toHaveBeenCalledWith("t_test", expect.objectContaining({
      primaryTrigger: { type: "self-schedule", interval: "12h" },
    }))
    expect(registry.updateStatus).toHaveBeenCalledWith("t_test", "weakened", { health: "削弱" })
  })

  it("weaken with explicit frequency", async () => {
    const mgr = mockManager()
    const registry = mockRegistry()
    const lifecycle = new TentacleLifecycleManager(mgr, null, mockCodeAgent(), registry, mockHealthCalc())

    await lifecycle.weaken("t_test", { newFrequency: "48h" })

    expect(mgr.setTentacleSchedule).toHaveBeenCalledWith("t_test", expect.objectContaining({
      primaryTrigger: { type: "self-schedule", interval: "48h" },
    }))
  })

  it("weaken throws if no schedule found", async () => {
    const mgr = mockManager()
    ;(mgr.getTentacleSchedule as any).mockResolvedValue(null)
    const lifecycle = new TentacleLifecycleManager(mgr, null, mockCodeAgent(), mockRegistry(), mockHealthCalc())

    await expect(lifecycle.weaken("t_missing")).rejects.toThrow("No schedule found")
  })

  it("strengthen updates frequency", async () => {
    const mgr = mockManager()
    const registry = mockRegistry()
    const lifecycle = new TentacleLifecycleManager(mgr, null, mockCodeAgent(), registry, mockHealthCalc())

    await lifecycle.strengthen("t_test", { newFrequency: "3h" })

    expect(mgr.setTentacleSchedule).toHaveBeenCalledWith("t_test", expect.objectContaining({
      primaryTrigger: { type: "self-schedule", interval: "3h" },
    }))
    expect(registry.updateStatus).toHaveBeenCalledWith("t_test", "running", { health: "良好" })
  })

  it("merge requires at least 2 tentacles", async () => {
    const lifecycle = new TentacleLifecycleManager(mockManager(), null, mockCodeAgent(), mockRegistry(), mockHealthCalc())

    await expect(lifecycle.merge(["t_one"], {
      newTentacleId: "t_merged",
      newPurpose: "merged",
    })).rejects.toThrow("at least 2 tentacles")
  })
})
