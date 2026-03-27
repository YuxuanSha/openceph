import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { ConsultationSessionStore } from "../../src/tentacle/consultation-session-store.js"

describe("ConsultationSessionStore", () => {
  let dir: string
  let store: ConsultationSessionStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-consultation-store-"))
    store = new ConsultationSessionStore(path.join(dir, "consultations.json"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("upserts and retrieves a consultation session as JSON", async () => {
    await store.upsert({
      sessionId: "session-1",
      tentacleId: "t_hn_monitor",
      mode: "batch",
      status: "open",
      requestIds: ["req-1"],
      turn: 2,
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:02:00.000Z",
    })

    const stateFile = path.join(dir, "consultations.json")
    expect(fs.existsSync(stateFile)).toBe(true)

    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0].sessionId).toBe("session-1")
    expect(state.sessions[0].tentacleId).toBe("t_hn_monitor")
    expect(state.sessions[0].status).toBe("open")

    const retrieved = await store.get("session-1")
    expect(retrieved).toBeDefined()
    expect(retrieved!.tentacleId).toBe("t_hn_monitor")
  })

  it("finds active sessions by tentacle id", async () => {
    await store.upsert({
      sessionId: "s1",
      tentacleId: "t_hn",
      mode: "batch",
      status: "open",
      requestIds: [],
      turn: 1,
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
    })
    await store.upsert({
      sessionId: "s2",
      tentacleId: "t_hn",
      mode: "batch",
      status: "closed",
      requestIds: [],
      turn: 1,
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
    })

    const active = await store.findActiveByTentacle("t_hn")
    expect(active).toHaveLength(1)
    expect(active[0].sessionId).toBe("s1")
  })

  it("closes a session", async () => {
    await store.upsert({
      sessionId: "s-close",
      tentacleId: "t_test",
      mode: "batch",
      status: "open",
      requestIds: [],
      turn: 1,
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
    })

    await store.close("s-close")
    const closed = await store.get("s-close")
    expect(closed!.status).toBe("closed")
  })
})
