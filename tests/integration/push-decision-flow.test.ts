import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { OutboundQueue } from "../../src/push/outbound-queue.js"
import { PushDecisionEngine } from "../../src/push/push-decision.js"
import { createTempIntegrationDir, initIntegrationConfig, makeApprovedItem } from "./helpers.js"

describe("integration: push decision flow", () => {
  let dir: string

  beforeEach(() => {
    dir = createTempIntegrationDir("openceph-push-flow-")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("consolidates batched pending items during daily review", async () => {
    const config = initIntegrationConfig(dir)
    const queue = new OutboundQueue(path.join(dir, "outbound.json"))
    const engine = new PushDecisionEngine(config, queue)

    await queue.addApprovedItem(makeApprovedItem({ itemId: "a", tentacleId: "t_rss", content: "Feed item A: agent security release" }))
    await queue.addApprovedItem(makeApprovedItem({ itemId: "b", tentacleId: "t_rss", content: "Feed item B: new benchmark report for browser agents" }))
    await queue.addApprovedItem(makeApprovedItem({ itemId: "c", tentacleId: "t_code", content: "Code item C: repository health trend changed" }))

    const decision = await engine.evaluate({ type: "daily_review" })
    expect(decision.shouldPush).toBe(true)
    expect(decision.reason).toBe("batch_threshold_reached")
    expect(decision.consolidatedText).toContain("Feed item A")
    expect(decision.consolidatedText).toContain("Code item C")
  })

  it("bypasses daily limit for urgent reports", async () => {
    const config = initIntegrationConfig(dir)
    const queue = new OutboundQueue(path.join(dir, "outbound-urgent.json"))
    const engine = new PushDecisionEngine(config, queue)

    engine.recordPush()
    engine.recordPush()
    engine.recordPush()
    await queue.addApprovedItem(makeApprovedItem({
      itemId: "urgent-1",
      tentacleId: "t_rss",
      content: "Security advisory in monitored feed",
      priority: "urgent",
      timelinessHint: "immediate",
    }))

    const decision = await engine.evaluate({ type: "urgent_report", tentacleId: "t_rss" })
    expect(decision.shouldPush).toBe(true)
    expect(decision.reason).toBe("urgent_report")
    expect(decision.items[0].priority).toBe("urgent")
  })
})
