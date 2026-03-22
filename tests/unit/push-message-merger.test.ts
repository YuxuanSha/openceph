import { describe, it, expect, beforeAll } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { mergeConsecutiveAssistantMessages } from "../../src/brain/extensions/push-message-merger.js"
import { initLoggers } from "../../src/logger/index.js"

describe("push-message-merger", () => {
  beforeAll(() => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-merger-log-"))
    initLoggers({
      logging: { logDir, level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    } as any)
  })

  it("merges consecutive assistant messages", () => {
    const merged = mergeConsecutiveAssistantMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "next" },
    ])

    expect(merged).toHaveLength(3)
    expect(merged[1].content).toBe("a\n\nb")
  })

  it("merges long assistant runs into one message", () => {
    const merged = mergeConsecutiveAssistantMessages([
      { role: "assistant", content: "1" },
      { role: "assistant", content: "2" },
      { role: "assistant", content: "3" },
      { role: "assistant", content: "4" },
      { role: "assistant", content: "5" },
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0].content).toBe("1\n\n2\n\n3\n\n4\n\n5")
  })

  it("does not merge across a user boundary", () => {
    const merged = mergeConsecutiveAssistantMessages([
      { role: "assistant", content: "before" },
      { role: "user", content: "interrupt" },
      { role: "assistant", content: "after" },
    ])

    expect(merged).toHaveLength(3)
  })

  it("keeps a single assistant push intact", () => {
    const merged = mergeConsecutiveAssistantMessages([
      { role: "assistant", content: "standalone push" },
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0].content).toBe("standalone push")
  })
})
