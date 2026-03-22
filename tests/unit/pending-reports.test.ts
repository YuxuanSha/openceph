import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { PendingReportsQueue } from "../../src/tentacle/pending-reports.js"

describe("PendingReportsQueue", () => {
  let dir: string
  let queue: PendingReportsQueue

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-pending-reports-"))
    queue = new PendingReportsQueue(path.join(dir, "pending.json"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("stores and marks reports processed", async () => {
    await queue.add({
      findingId: "f1",
      tentacleId: "t_demo",
      summary: "demo",
      confidence: 0.8,
      createdAt: "2026-03-20T00:00:00Z",
      status: "pending",
    })

    expect(await queue.size()).toBe(1)
    await queue.markProcessed("f1", "sent")
    expect(await queue.size()).toBe(0)
    expect((await queue.getAll())[0].status).toBe("sent")
  })

  it("discards oldest pending reports when queue exceeds the cap", async () => {
    queue = new PendingReportsQueue(path.join(dir, "pending.json"), 2)

    await queue.add({
      findingId: "f1",
      tentacleId: "t_demo",
      summary: "first",
      confidence: 0.8,
      createdAt: "2026-03-20T00:00:00Z",
      status: "pending",
    })
    await queue.add({
      findingId: "f2",
      tentacleId: "t_demo",
      summary: "second",
      confidence: 0.8,
      createdAt: "2026-03-20T00:01:00Z",
      status: "pending",
    })
    await queue.add({
      findingId: "f3",
      tentacleId: "t_demo",
      summary: "third",
      confidence: 0.8,
      createdAt: "2026-03-20T00:02:00Z",
      status: "pending",
    })

    const reports = await queue.getAll()
    expect(await queue.size()).toBe(2)
    expect(reports.find((report) => report.findingId === "f1")?.status).toBe("discarded")
    expect(reports.find((report) => report.findingId === "f2")?.status).toBe("pending")
    expect(reports.find((report) => report.findingId === "f3")?.status).toBe("pending")
  })
})
