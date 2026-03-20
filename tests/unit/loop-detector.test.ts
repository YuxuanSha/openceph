import { describe, it, expect } from "vitest"
import { LoopDetector } from "../../src/brain/loop-detection.js"

const config = {
  enabled: true,
  warningThreshold: 3,
  criticalThreshold: 5,
  historySize: 20,
  detectors: {
    genericRepeat: true,
    knownPollNoProgress: true,
    pingPong: true,
  },
}

describe("LoopDetector", () => {
  it("detects generic repeat", () => {
    const detector = new LoopDetector(config)
    for (let i = 0; i < 3; i++) {
      detector.record("memory_search", { query: "tea" }, { ok: true })
    }
    expect(detector.check()).toMatchObject({ detected: true, level: "warning", detector: "genericRepeat" })
  })

  it("detects ping pong pattern", () => {
    const detector = new LoopDetector(config)
    detector.record("web_search", { q: "a" }, { r: 1 })
    detector.record("web_fetch", { u: "x" }, { r: 2 })
    detector.record("web_search", { q: "a" }, { r: 1 })
    detector.record("web_fetch", { u: "x" }, { r: 2 })
    expect(detector.check()).toMatchObject({ detected: true, detector: "pingPong" })
  })
})
