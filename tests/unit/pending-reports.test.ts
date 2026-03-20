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
})
