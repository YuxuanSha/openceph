import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { TentacleRegistry } from "../../src/tentacle/registry.js"

describe("TentacleRegistry", () => {
  let dir: string
  let registry: TentacleRegistry

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-tentacle-registry-"))
    registry = new TentacleRegistry(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("registers and updates a tentacle entry", async () => {
    await registry.register({
      tentacleId: "t_demo",
      status: "running",
      purpose: "demo",
      createdAt: "2026-03-20T00:00:00Z",
      runtime: "python",
    })
    await registry.updateStatus("t_demo", "paused", { health: "良好" })

    const entries = await registry.readAll()
    expect(entries).toHaveLength(1)
    expect(entries[0].tentacleId).toBe("t_demo")
    expect(entries[0].status).toBe("paused")
    expect(entries[0].health).toBe("良好")
  })
})
