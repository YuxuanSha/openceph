import { describe, it, expect } from "vitest"
import {
  evaluateConsultationReset,
  getDefaultConsultationResetPolicy,
  planConsultationDecision,
} from "../../src/tentacle/consultation-policy.js"

describe("consultation-policy", () => {
  it("returns a send decision for a standard consultation request", () => {
    const plan = planConsultationDecision(
      {
        mode: "batch",
        summary: "No important updates",
        initial_message: "HN monitor: no high-scoring news found this cycle.",
        item_count: 1,
      },
      "session-1",
      { purpose: "Monitor HN" },
      "2026-03-24T00:05:00.000Z",
    )

    expect(plan.decision).toBe("send")
    expect(plan.approvedItems).toHaveLength(1)
    expect(plan.pendingItems).toHaveLength(0)
  })

  it("handles single mode consultation requests", () => {
    const plan = planConsultationDecision(
      {
        mode: "single",
        summary: "Routine heartbeat",
        initial_message: "HN monitor: no important news. Routine status check.",
        item_count: 1,
      },
      "session-1",
      { reportStrategy: "report every 5 minutes" },
      "2026-03-24T00:05:00.000Z",
    )

    expect(plan.decision).toBe("send")
    expect(plan.approvedItems).toHaveLength(1)
  })

  it("resets consultation sessions when max turns or max age is reached", () => {
    const policy = getDefaultConsultationResetPolicy({ maxTurns: 3, maxAgeMinutes: 60 })

    const turnReset = evaluateConsultationReset(
      {
        sessionId: "s-1",
        sessionKey: "consultation:s-1",
        tentacleId: "t_hn",
        mode: "batch",
        status: "resolved",
        requestIds: ["r-1"],
        turn: 3,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:10:00.000Z",
      },
      policy,
      "2026-03-24T00:20:00.000Z",
    )

    const ageReset = evaluateConsultationReset(
      {
        sessionId: "s-2",
        sessionKey: "consultation:s-2",
        tentacleId: "t_hn",
        mode: "batch",
        status: "resolved",
        requestIds: ["r-1"],
        turn: 1,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:10:00.000Z",
      },
      policy,
      "2026-03-24T01:30:00.000Z",
    )

    expect(turnReset).toEqual({ shouldReset: true, reason: "max_turns" })
    expect(ageReset).toEqual({ shouldReset: true, reason: "max_age" })
  })
})
