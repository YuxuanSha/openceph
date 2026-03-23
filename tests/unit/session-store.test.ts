import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { SessionStoreManager } from "../../src/session/session-store.js"

// Override the base dir for testing
function createTestManager(baseDir: string): SessionStoreManager {
  const mgr = new SessionStoreManager("test-agent")
  // Override the private baseDir
  ;(mgr as any).baseDir = baseDir
  return mgr
}

describe("SessionStoreManager", () => {
  let dir: string
  let mgr: SessionStoreManager

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-session-test-"))
    mgr = createTestManager(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("getOrCreate creates new entry when key does not exist", async () => {
    const entry = await mgr.getOrCreate("agent:ceph:main")
    expect(entry.sessionId).toBeTruthy()
    expect(entry.sessionKey).toBe("agent:ceph:main")
    expect(entry.inputTokens).toBe(0)
    expect(entry.outputTokens).toBe(0)
  })

  it("getOrCreate returns existing entry for same key", async () => {
    const entry1 = await mgr.getOrCreate("agent:ceph:main")
    const entry2 = await mgr.getOrCreate("agent:ceph:main")
    expect(entry1.sessionId).toBe(entry2.sessionId)
  })

  it("reset archives old JSONL and creates new session", async () => {
    const entry1 = await mgr.getOrCreate("agent:ceph:main")

    // Create a fake JSONL file
    const jsonlPath = mgr.getTranscriptPath(entry1.sessionId)
    fs.writeFileSync(jsonlPath, '{"test": true}\n')

    const entry2 = await mgr.reset("agent:ceph:main", "manual")

    expect(entry2.sessionId).not.toBe(entry1.sessionId)
    expect(entry2.inputTokens).toBe(0)

    // Old JSONL should be renamed
    expect(fs.existsSync(jsonlPath)).toBe(false)

    // Archive file should exist
    const files = fs.readdirSync(dir)
    const archiveFile = files.find((f) => f.includes(".reset."))
    expect(archiveFile).toBeTruthy()
  })

  it("reset works when no JSONL file exists", async () => {
    await mgr.getOrCreate("agent:ceph:main")
    const entry = await mgr.reset("agent:ceph:main", "daily")
    expect(entry.sessionId).toBeTruthy()
  })

  it("updateTokens accumulates correctly", async () => {
    await mgr.getOrCreate("agent:ceph:main")

    await mgr.updateTokens("agent:ceph:main", { input: 100, output: 50 })
    await mgr.updateTokens("agent:ceph:main", { input: 200, output: 100 })

    const entries = await mgr.list()
    const entry = entries.find((e) => e.sessionKey === "agent:ceph:main")!
    expect(entry.inputTokens).toBe(300)
    expect(entry.outputTokens).toBe(150)
    expect(entry.totalTokens).toBe(450)
  })

  it("updateModel persists the selected model for a session", async () => {
    await mgr.getOrCreate("agent:ceph:main", { model: "openrouter/google/gemini-3-flash-preview" })

    await mgr.updateModel("agent:ceph:main", "openrouter/google/gemini-3-flash-preview")

    const entry = await mgr.get("agent:ceph:main")
    expect(entry?.model).toBe("openrouter/google/gemini-3-flash-preview")
  })

  it("reset preserves the selected model for the session", async () => {
    await mgr.getOrCreate("agent:ceph:main", { model: "openrouter/google/gemini-3-flash-preview" })

    const entry = await mgr.reset("agent:ceph:main", "manual")

    expect(entry.model).toBe("openrouter/google/gemini-3-flash-preview")
  })

  it("concurrent updateTokens are safe", async () => {
    await mgr.getOrCreate("agent:ceph:main")

    // Run 5 concurrent updates
    await Promise.all([
      mgr.updateTokens("agent:ceph:main", { input: 100, output: 50 }),
      mgr.updateTokens("agent:ceph:main", { input: 100, output: 50 }),
      mgr.updateTokens("agent:ceph:main", { input: 100, output: 50 }),
      mgr.updateTokens("agent:ceph:main", { input: 100, output: 50 }),
      mgr.updateTokens("agent:ceph:main", { input: 100, output: 50 }),
    ])

    const entries = await mgr.list()
    const entry = entries.find((e) => e.sessionKey === "agent:ceph:main")!
    expect(entry.inputTokens).toBe(500)
    expect(entry.outputTokens).toBe(250)
    expect(entry.totalTokens).toBe(750)
  })

  it("list returns all entries", async () => {
    await mgr.getOrCreate("agent:ceph:main")
    await mgr.getOrCreate("agent:ceph:dm:user1")

    const entries = await mgr.list()
    expect(entries.length).toBe(2)
  })

  it("cleanup removes old archive files", async () => {
    const entry = await mgr.getOrCreate("agent:ceph:main")

    // Create some fake archive files with old timestamps
    for (let i = 0; i < 5; i++) {
      const archiveName = `${entry.sessionId}.jsonl.reset.2025-01-0${i + 1}T00-00-00.000Z`
      const archivePath = path.join(dir, archiveName)
      fs.writeFileSync(archivePath, `{"data": ${i}}\n`)
      // Set mtime to the past
      const oldTime = new Date("2025-01-01")
      fs.utimesSync(archivePath, oldTime, oldTime)
    }

    const result = await mgr.cleanup({
      maxArchiveFilesPerKey: 30,
      archiveTtlDays: 1, // 1 day TTL — all old files should be deleted
    })

    expect(result.deletedFiles).toBe(5)
  })
})
