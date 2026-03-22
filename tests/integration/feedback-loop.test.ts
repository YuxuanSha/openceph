import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { PushFeedbackTracker } from "../../src/push/feedback-tracker.js"
import { createTempIntegrationDir, initIntegrationConfig } from "./helpers.js"

describe("integration: feedback loop", () => {
  let dir: string

  beforeEach(() => {
    dir = createTempIntegrationDir("openceph-feedback-")
    initIntegrationConfig(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("persists user feedback and updates per-tentacle adoption files", async () => {
    const tracker = new PushFeedbackTracker(path.join(dir, "workspace", "memory"), null)

    await tracker.recordFeedback({
      messageId: "push-1",
      sourceTentacles: ["t_rss"],
      reaction: "positive",
      timestamp: new Date().toISOString(),
    })
    await tracker.recordFeedback({
      messageId: "push-2",
      sourceTentacles: ["t_rss"],
      reaction: "negative",
      timestamp: new Date().toISOString(),
    })

    const adoption = await tracker.getAdoptionRate("t_rss", 30)
    const store = JSON.parse(fs.readFileSync(path.join(dir, "workspace", "memory", "push-feedback.json"), "utf-8"))
    const tentacleFeedback = JSON.parse(fs.readFileSync(path.join(dir, "workspace", "tentacles", "t_rss", "feedback.json"), "utf-8"))

    expect(store.feedbacks).toHaveLength(2)
    expect(tentacleFeedback).toEqual({ positive: 1, negative: 1, ignored: 0 })
    expect(adoption).toBe(0.5)
  })
})
