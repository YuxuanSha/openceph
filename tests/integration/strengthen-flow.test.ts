import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { CodeAgent } from "../../src/code-agent/code-agent.js"
import { TentacleLifecycleManager } from "../../src/tentacle/lifecycle.js"
import { createTempIntegrationDir, initIntegrationConfig, makePythonTentacleCode } from "./helpers.js"

describe("integration: strengthen flow", () => {
  let dir: string

  beforeEach(() => {
    dir = createTempIntegrationDir("openceph-strengthen-")
    initIntegrationConfig(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("applies a strengthen patch, validates it, and restarts the tentacle", async () => {
    const baseDir = path.join(dir, "tentacles")
    const tentacleId = "t_rss_upgrade"
    const tentacleDir = path.join(baseDir, tentacleId)
    fs.mkdirSync(tentacleDir, { recursive: true })

    const code = makePythonTentacleCode(tentacleId, "Monitor RSS feeds")
    fs.writeFileSync(path.join(tentacleDir, "main.py"), code.files[0].content)
    fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), JSON.stringify({
      runtime: "python",
      entryCommand: "python3 main.py",
      cwd: tentacleDir,
      purpose: "Monitor RSS feeds",
      trigger: "6h",
    }, null, 2))

    const manager = {
      getTentacleBaseDir: () => baseDir,
      getTentacleDir: () => tentacleDir,
      getTentacleSchedule: vi.fn().mockResolvedValue({
        primaryTrigger: { type: "self-schedule", interval: "6h" },
        cronJobs: [],
      }),
      setTentacleSchedule: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn().mockResolvedValue(true),
      spawn: vi.fn().mockResolvedValue(undefined),
      waitForRegistration: vi.fn().mockResolvedValue(true),
      getStatus: vi.fn().mockReturnValue({ tentacleId, status: "running" }),
    } as any
    const registry = {
      updateStatus: vi.fn().mockResolvedValue(undefined),
    } as any

    const lifecycle = new TentacleLifecycleManager(
      manager,
      null,
      new CodeAgent({} as any, {} as any),
      registry,
      {} as any,
    )

    await lifecycle.strengthen(tentacleId, {
      newFrequency: "3h",
      additionalCapabilities: ["web_search"],
      upgradeDescription: "Prioritize urgent RSS items and raise polling cadence",
    })

    expect(manager.setTentacleSchedule).toHaveBeenCalledWith(tentacleId, expect.objectContaining({
      primaryTrigger: { type: "self-schedule", interval: "3h" },
    }))
    expect(manager.kill).toHaveBeenCalledWith(tentacleId, "strengthen_restart")
    expect(manager.spawn).toHaveBeenCalledWith(tentacleId)
    expect(fs.readFileSync(path.join(tentacleDir, "main.py"), "utf-8")).toContain("OpenCeph upgrade")
    expect(fs.readFileSync(path.join(tentacleDir, "UPGRADE_NOTES.md"), "utf-8")).toContain("Prioritize urgent RSS items")
    expect(registry.updateStatus).toHaveBeenLastCalledWith(tentacleId, "running", { health: "good" })
  }, 20_000)
})
