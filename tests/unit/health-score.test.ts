import { describe, it, expect, beforeEach } from "vitest"
import { TentacleHealthCalculator, type HealthScore } from "../../src/tentacle/health-score.js"
import type { TentacleManager } from "../../src/tentacle/manager.js"
import type { PendingReportsQueue } from "../../src/tentacle/pending-reports.js"

function mockManager(overrides: Partial<Record<string, any>> = {}): TentacleManager {
  return {
    getTentacleBaseDir: () => "/tmp/test-health",
    getStatus: (id: string) => overrides.status?.[id] ?? undefined,
    listAll: () => overrides.listAll ?? [],
    getTentacleDir: (id: string) => `/tmp/test-health/${id}`,
    ...overrides,
  } as any
}

function mockQueue(reports: any[] = []): PendingReportsQueue {
  return {
    getAll: async () => reports,
  } as any
}

describe("TentacleHealthCalculator", () => {
  it("returns empty score for unknown tentacle", async () => {
    const calc = new TentacleHealthCalculator(mockManager(), mockQueue())
    const score = await calc.calculate("unknown")
    expect(score.score).toBe(0)
    expect(score.trend).toBe("stable")
  })

  it("calculates score with recent reports", async () => {
    const now = new Date().toISOString()
    const manager = mockManager({
      status: {
        t_test: {
          tentacleId: "t_test",
          status: "running",
          totalReports: 5,
          lastReportAt: now,
        },
      },
    })
    const queue = mockQueue([
      { tentacleId: "t_test", status: "sent" },
      { tentacleId: "t_test", status: "sent" },
      { tentacleId: "t_test", status: "discarded" },
    ])
    const calc = new TentacleHealthCalculator(manager, queue)
    const score = await calc.calculate("t_test")

    expect(score.score).toBeGreaterThan(0)
    expect(score.score).toBeLessThanOrEqual(1)
    expect(score.components.reportFrequency).toBeGreaterThan(0)
    // 2 sent out of 3 total = ~0.67
    expect(score.components.avgQuality).toBeCloseTo(2 / 3, 1)
    // No feedback.json → default 0.5
    expect(score.components.adoptionRate).toBe(0.5)
    expect(score.trend).toBe("stable")
  })

  it("penalizes stale tentacles", async () => {
    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const manager = mockManager({
      status: {
        t_stale: {
          tentacleId: "t_stale",
          status: "running",
          totalReports: 2,
          lastReportAt: staleDate,
        },
      },
    })
    const calc = new TentacleHealthCalculator(manager, mockQueue())
    const score = await calc.calculate("t_stale")

    // 10 days since last report → heavily penalized frequency
    expect(score.components.reportFrequency).toBeLessThanOrEqual(0.1)
    expect(score.score).toBeLessThan(0.5)
  })

  it("calculateAll skips killed tentacles", async () => {
    const manager = mockManager({
      listAll: () => [
        { tentacleId: "t_a", status: "running" },
        { tentacleId: "t_b", status: "killed" },
      ],
      status: {
        t_a: { tentacleId: "t_a", status: "running", totalReports: 1, lastReportAt: new Date().toISOString() },
      },
    })
    const calc = new TentacleHealthCalculator(manager, mockQueue())
    const all = await calc.calculateAll()

    expect(all.has("t_a")).toBe(true)
    expect(all.has("t_b")).toBe(false)
  })
})
