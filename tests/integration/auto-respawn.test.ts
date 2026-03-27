import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { IpcServer } from "../../src/tentacle/ipc-server.js"
import { TentacleRegistry } from "../../src/tentacle/registry.js"
import { PendingReportsQueue } from "../../src/tentacle/pending-reports.js"
import { TentacleManager } from "../../src/tentacle/manager.js"
import { initIntegrationConfig } from "./helpers.js"

describe("integration: auto-respawn on startup", () => {
  let dir: string
  let ipc: IpcServer

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-respawn-"))
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true })
    fs.writeFileSync(path.join(dir, "workspace", "TENTACLES.md"), "# TENTACLES.md\n")
  })

  afterEach(async () => {
    await ipc?.stop().catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("respawns tentacles marked running in registry on startup", async () => {
    const config = initIntegrationConfig(dir)
    ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()

    const registry = new TentacleRegistry(path.join(dir, "workspace"))
    const queue = new PendingReportsQueue(path.join(dir, "pending.json"))
    const manager = new TentacleManager(config, ipc, registry, queue)

    // Create a tentacle directory with tentacle.json and a simple process
    const tentacleDir = path.join(manager.getTentacleBaseDir(), "t_respawn_test")
    fs.mkdirSync(tentacleDir, { recursive: true })
    fs.writeFileSync(path.join(tentacleDir, "main.py"), `
import json, os, sys, time, uuid
def send(t, payload):
  sys.stdout.write(json.dumps({"type":t,"sender":os.environ.get("OPENCEPH_TENTACLE_ID","t_respawn_test"),"receiver":"brain","payload":payload,"timestamp":"x","message_id":str(uuid.uuid4())})+"\\n")
  sys.stdout.flush()
send("tentacle_register", {"purpose":"respawn test","runtime":"python"})
while True: time.sleep(1)
`)
    fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), JSON.stringify({
      tentacleId: "t_respawn_test",
      purpose: "respawn test",
      runtime: "python",
      entryCommand: "python3 main.py",
      trigger: "external",
    }))

    // Register the tentacle as "running" in the registry
    await registry.register({
      tentacleId: "t_respawn_test",
      status: "running",
      purpose: "respawn test",
      runtime: "python",
      trigger: "external",
      createdAt: new Date().toISOString(),
    })

    // Restore metadata then respawn
    await manager.restoreFromRegistry()
    await manager.respawnFromRegistry()

    // The tentacle should now have a running process
    const status = manager.getStatus("t_respawn_test")
    expect(status).toBeDefined()
    expect(status!.status).toBe("running")
    expect(status!.pid).toBeDefined()

    // Clean up
    await manager.kill("t_respawn_test", "test_cleanup")
    await ipc.stop()
  }, 35_000)

  it("marks tentacle as crashed when tentacle.json is missing", async () => {
    const config = initIntegrationConfig(dir)
    ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()

    const registry = new TentacleRegistry(path.join(dir, "workspace"))
    const queue = new PendingReportsQueue(path.join(dir, "pending.json"))
    const manager = new TentacleManager(config, ipc, registry, queue)

    // Register a tentacle as "running" but DON'T create tentacle.json
    await registry.register({
      tentacleId: "t_missing_meta",
      status: "running",
      purpose: "missing metadata test",
      runtime: "python",
      createdAt: new Date().toISOString(),
    })

    await manager.restoreFromRegistry()
    await manager.respawnFromRegistry()

    // Should be marked as crashed
    const status = manager.getStatus("t_missing_meta")
    expect(status).toBeDefined()
    expect(status!.status).toBe("crashed")
    expect(status!.healthScore).toBe(0)

    await ipc.stop()
  }, 10_000)

  it("does not respawn tentacles with non-running status", async () => {
    const config = initIntegrationConfig(dir)
    ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()

    const registry = new TentacleRegistry(path.join(dir, "workspace"))
    const queue = new PendingReportsQueue(path.join(dir, "pending.json"))
    const manager = new TentacleManager(config, ipc, registry, queue)

    // Register a stopped tentacle
    await registry.register({
      tentacleId: "t_stopped",
      status: "stopped",
      purpose: "stopped test",
      runtime: "python",
      createdAt: new Date().toISOString(),
    })

    await manager.restoreFromRegistry()
    await manager.respawnFromRegistry()

    // Should NOT attempt to respawn — status stays "stopped"
    const status = manager.getStatus("t_stopped")
    expect(status).toBeDefined()
    expect(status!.status).toBe("stopped")
    expect(status!.pid).toBeUndefined()

    await ipc.stop()
  }, 10_000)
})
