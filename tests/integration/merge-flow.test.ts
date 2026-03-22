import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { TentacleLifecycleManager } from "../../src/tentacle/lifecycle.js"
import { createTempIntegrationDir, initIntegrationConfig, makePythonTentacleCode } from "./helpers.js"

describe("integration: merge flow", () => {
  let dir: string

  beforeEach(() => {
    dir = createTempIntegrationDir("openceph-merge-")
    initIntegrationConfig(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("merges two tentacles into one validated replacement tentacle", async () => {
    const baseDir = path.join(dir, "tentacles")
    const sourceIds = ["t_rss_news", "t_rss_releases"]

    for (const tentacleId of sourceIds) {
      const tentacleDir = path.join(baseDir, tentacleId)
      fs.mkdirSync(tentacleDir, { recursive: true })
      fs.writeFileSync(path.join(tentacleDir, "main.py"), `print(${JSON.stringify(tentacleId)})\n`)
      fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), JSON.stringify({
        runtime: "python",
        entryCommand: "python3 main.py",
        cwd: tentacleDir,
        purpose: `Purpose for ${tentacleId}`,
      }, null, 2))
    }

    const manager = {
      getTentacleBaseDir: () => baseDir,
      getTentacleDir: (id: string) => path.join(baseDir, id),
      getStatus: vi.fn((id: string) => ({
        tentacleId: id,
        status: "running",
        purpose: id === "t_rss_news" ? "monitor AI news RSS feeds" : "monitor AI release RSS feeds",
        runtime: "python",
      })),
      spawn: vi.fn().mockResolvedValue(undefined),
      waitForRegistration: vi.fn().mockResolvedValue(true),
      kill: vi.fn().mockResolvedValue(true),
    } as any
    const registry = {
      updateStatus: vi.fn().mockResolvedValue(undefined),
    } as any
    const codeAgent = {
      generateMerged: vi.fn().mockResolvedValue(
        makePythonTentacleCode("t_rss_unified", "Unified RSS monitor"),
      ),
    } as any

    const lifecycle = new TentacleLifecycleManager(
      manager,
      null,
      codeAgent,
      registry,
      {} as any,
    )

    const result = await lifecycle.merge(sourceIds, {
      newTentacleId: "t_rss_unified",
      newPurpose: "Unified AI RSS monitor",
    })

    expect(result.newTentacleId).toBe("t_rss_unified")
    expect(fs.existsSync(path.join(result.directory, "tentacle.json"))).toBe(true)
    expect(manager.spawn).toHaveBeenCalledWith("t_rss_unified")
    expect(manager.kill).toHaveBeenCalledTimes(2)
    expect(registry.updateStatus).toHaveBeenCalledWith("t_rss_unified", "running", expect.objectContaining({
      purpose: "Unified AI RSS monitor",
    }))
  }, 20_000)
})
