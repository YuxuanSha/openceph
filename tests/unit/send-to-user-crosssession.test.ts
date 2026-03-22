import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { initLoggers } from "../../src/logger/index.js"
import { SessionStoreManager } from "../../src/session/session-store.js"
import { executeSendToUser } from "../../src/tools/user-tools.js"

function createTestManager(baseDir: string): SessionStoreManager {
  const mgr = new SessionStoreManager("test-agent")
  ;(mgr as any).baseDir = baseDir
  return mgr
}

describe("send_to_user cross-session flow", () => {
  let dir: string
  let sessionStore: SessionStoreManager

  beforeAll(() => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-send-user-log-"))
    initLoggers({
      logging: { logDir, level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    } as any)
  })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-send-user-"))
    sessionStore = createTestManager(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("consultation session writes to main transcript and delivers immediately", async () => {
    const mainSession = await sessionStore.getOrCreate("agent:ceph:main")
    const deliver = vi.fn().mockResolvedValue(undefined)

    const result = await executeSendToUser(
      {
        message: "📡 新发现",
        timing: "immediate",
        channel: "last_active",
        priority: "urgent",
        source_tentacles: ["t_hn"],
      },
      {
        currentSessionKey: "consultation:abc",
        mainSessionKey: "agent:ceph:main",
        deliverToUser: deliver,
        lastActiveChannel: () => "telegram",
        lastActiveSenderId: () => "user-1",
        sessionStore,
      },
    )

    expect((result.details as any)?.pushId).toMatch(/^p-/)
    expect(deliver).toHaveBeenCalledTimes(1)

    const transcript = fs.readFileSync(sessionStore.getTranscriptPath(mainSession.sessionId), "utf-8").trim().split("\n")
    expect(transcript).toHaveLength(1)
    const entry = JSON.parse(transcript[0])
    expect(entry.role).toBe("assistant")
    expect(entry.content).toBe("📡 新发现")
    expect(entry.metadata.source).toBe("tentacle_push")
    expect(entry.metadata.tentacleId).toBe("t_hn")
    expect(entry.metadata.consultationSessionId).toBe("consultation:abc")
  })

  it("main session keeps existing behavior and does not append transcript", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined)
    await sessionStore.getOrCreate("agent:ceph:main")

    await executeSendToUser(
      {
        message: "正常主动消息",
        timing: "immediate",
        channel: "telegram",
      },
      {
        currentSessionKey: "agent:ceph:main",
        mainSessionKey: "agent:ceph:main",
        deliverToUser: deliver,
        lastActiveChannel: () => "telegram",
        lastActiveSenderId: () => "user-1",
        sessionStore,
      },
    )

    expect(deliver).toHaveBeenCalledTimes(1)
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
    expect(files).toHaveLength(0)
  })

  it("consultation session queues deferred push without writing main transcript yet", async () => {
    const mainSession = await sessionStore.getOrCreate("agent:ceph:main")
    const queuePath = path.join(dir, "outbound.json")

    const result = await executeSendToUser(
      {
        message: "晨报里再发",
        timing: "morning_digest",
        channel: "last_active",
        source_tentacles: ["t_digest"],
      },
      {
        currentSessionKey: "consultation:queued",
        mainSessionKey: "agent:ceph:main",
        lastActiveChannel: () => "telegram",
        lastActiveSenderId: () => "user-1",
        sessionStore,
        queuePath,
      },
    )

    expect((result.details as any)?.delivered).toBe(false)
    const transcriptPath = sessionStore.getTranscriptPath(mainSession.sessionId)
    expect(fs.existsSync(transcriptPath)).toBe(false)

    const queued = JSON.parse(fs.readFileSync(queuePath, "utf-8"))
    expect(queued).toHaveLength(1)
    expect(queued[0].kind).toBe("deferred_message")
    expect(queued[0].targetSessionKey).toBe("agent:ceph:main")
    expect(queued[0].sourceSessionKey).toBe("consultation:queued")
  })
})
