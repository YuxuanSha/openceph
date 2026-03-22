import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { SessionStoreManager } from "../../src/session/session-store.js"

function createTestManager(baseDir: string): SessionStoreManager {
  const mgr = new SessionStoreManager("test-agent")
  ;(mgr as any).baseDir = baseDir
  return mgr
}

describe("SessionStoreManager.appendAssistantMessage", () => {
  let dir: string
  let mgr: SessionStoreManager

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-session-append-"))
    mgr = createTestManager(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("appends assistant JSONL rows with metadata", async () => {
    const entry = await mgr.getOrCreate("agent:ceph:main")
    await mgr.appendAssistantMessage("agent:ceph:main", "hello push", { source: "tentacle_push", pushId: "p-1" })

    const lines = fs.readFileSync(mgr.getTranscriptPath(entry.sessionId), "utf-8").trim().split("\n")
    expect(lines).toHaveLength(1)
    const row = JSON.parse(lines[0])
    expect(row.role).toBe("assistant")
    expect(row.content).toBe("hello push")
    expect(row.metadata.pushId).toBe("p-1")
    expect(typeof row.timestamp).toBe("string")
  })

  it("is safe under concurrent appends", async () => {
    const entry = await mgr.getOrCreate("agent:ceph:main")
    await Promise.all([
      mgr.appendAssistantMessage("agent:ceph:main", "a"),
      mgr.appendAssistantMessage("agent:ceph:main", "b"),
      mgr.appendAssistantMessage("agent:ceph:main", "c"),
      mgr.appendAssistantMessage("agent:ceph:main", "d"),
      mgr.appendAssistantMessage("agent:ceph:main", "e"),
    ])

    const lines = fs.readFileSync(mgr.getTranscriptPath(entry.sessionId), "utf-8").trim().split("\n")
    expect(lines).toHaveLength(5)
    const contents = lines.map((line) => JSON.parse(line).content).sort()
    expect(contents).toEqual(["a", "b", "c", "d", "e"])
  })
})
