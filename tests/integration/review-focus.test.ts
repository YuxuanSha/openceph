import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { MemoryManager } from "../../src/memory/memory-manager.js"
import { OutboundQueue } from "../../src/push/outbound-queue.js"
import { TentacleReviewEngine } from "../../src/tentacle/review-engine.js"
import { createTempIntegrationDir, initIntegrationConfig, makeApprovedItem } from "./helpers.js"

describe("integration: review focus", () => {
  let dir: string

  beforeEach(() => {
    dir = createTempIntegrationDir("openceph-review-focus-")
    initIntegrationConfig(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("recommends strengthen when user memory and pending pushes both align", async () => {
    const workspace = path.join(dir, "workspace")
    fs.writeFileSync(path.join(workspace, "MEMORY.md"), [
      "# MEMORY.md",
      "## Focus",
      "- user is actively tracking AI RSS feeds, agent releases, and blog monitoring quality",
    ].join("\n"))

    const queue = new OutboundQueue(path.join(dir, "outbound.json"))
    await queue.addApprovedItem(makeApprovedItem({
      itemId: "rss-1",
      tentacleId: "t_rss_focus",
      content: "Queued RSS summary",
      priority: "high",
    }))

    const engine = new TentacleReviewEngine(
      {
        listAll: () => [{
          tentacleId: "t_rss_focus",
          id: "t_rss_focus",
          purpose: "monitor AI RSS feeds and agent releases",
          triggerType: "schedule",
          status: "running",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          totalReports: 5,
          totalFindings: 5,
          healthScore: 0.6,
          directory: path.join(dir, "tentacles", "t_rss_focus"),
        }],
      } as any,
      {
        calculateAll: async () => new Map([["t_rss_focus", {
          score: 0.6,
          components: { reportFrequency: 0.6, avgQuality: 0.6, adoptionRate: 0.6 },
          trend: "stable",
          lastCalculatedAt: new Date().toISOString(),
        }]]),
      } as any,
      new MemoryManager(workspace),
      queue,
    )

    const actions = await engine.review()
    expect(actions).toHaveLength(1)
    expect(actions[0].action).toBe("strengthen")
    expect(actions[0].reason).toContain("pending push item")
  })
})
