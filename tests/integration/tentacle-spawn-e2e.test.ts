import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { IpcServer } from "../../src/tentacle/ipc-server.js"
import { TentacleRegistry } from "../../src/tentacle/registry.js"
import { PendingReportsQueue } from "../../src/tentacle/pending-reports.js"
import { TentacleManager } from "../../src/tentacle/manager.js"
import { initIntegrationConfig } from "./helpers.js"

describe("integration: tentacle spawn e2e", () => {
  let dir: string
  let ipc: IpcServer
  let mgr: TentacleManager

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-spawn-e2e-"))
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true })
    fs.writeFileSync(path.join(dir, "workspace", "TENTACLES.md"), "# TENTACLES.md\n")
  })

  afterEach(async () => {
    await mgr?.shutdown().catch(() => {})
    // Wait for async crash handlers to settle
    await new Promise((r) => setTimeout(r, 1000))
    await ipc?.stop().catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("spawns a tentacle, registers via IPC, and sends consultation_request", async () => {
    const config = initIntegrationConfig(dir)
    ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()

    const registry = new TentacleRegistry(path.join(dir, "workspace"))
    const queue = new PendingReportsQueue(path.join(dir, "pending.json"))
    mgr = new TentacleManager(config, ipc, registry, queue)

    // Create a tentacle that registers and sends a consultation_request
    const tentacleDir = path.join(mgr.getTentacleBaseDir(), "t_spawn_e2e")
    fs.mkdirSync(tentacleDir, { recursive: true })
    fs.writeFileSync(path.join(tentacleDir, "main.py"), `
import json, os, sys, time, uuid
tid = os.environ.get("OPENCEPH_TENTACLE_ID", "t_spawn_e2e")
def send(t, payload):
  sys.stdout.write(json.dumps({"type":t,"tentacle_id":tid,"message_id":str(uuid.uuid4()),"timestamp":"x","payload":payload})+"\\n")
  sys.stdout.flush()
send("tentacle_register", {"purpose":"spawn e2e test","runtime":"python","pid":os.getpid(),"capabilities":{"daemon":[],"agent":[],"consultation":{"mode":"batch"}}})
time.sleep(0.3)
send("consultation_request", {"mode":"batch","summary":"spawn e2e report","initial_message":"spawn e2e findings","item_count":1,"urgency":"normal","context":{}})
while True: time.sleep(1)
`)
    fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), JSON.stringify({
      tentacleId: "t_spawn_e2e",
      purpose: "spawn e2e test",
      runtime: "python",
      entryCommand: "python3 main.py",
      trigger: "external",
    }))

    // Spawn and wait for IPC registration
    await mgr.spawn("t_spawn_e2e")
    const registered = await mgr.waitForRegistration("t_spawn_e2e", 10_000)
    expect(registered).toBe(true)

    // Verify status is running
    const status = mgr.getStatus("t_spawn_e2e")
    expect(status).toBeDefined()
    expect(status!.status).toBe("running")
    expect(status!.pid).toBeDefined()

    // Verify the tentacle is connected via IPC
    const connected = ipc.getConnectedTentacles()
    expect(connected).toContain("t_spawn_e2e")
  }, 15_000)

  it("handles spawn failure when entry command is invalid", async () => {
    const config = initIntegrationConfig(dir)
    ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()

    const registry = new TentacleRegistry(path.join(dir, "workspace"))
    const queue = new PendingReportsQueue(path.join(dir, "pending.json"))
    mgr = new TentacleManager(config, ipc, registry, queue)

    // Create a tentacle with a bad entry command
    const tentacleDir = path.join(mgr.getTentacleBaseDir(), "t_bad_entry")
    fs.mkdirSync(tentacleDir, { recursive: true })
    fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), JSON.stringify({
      tentacleId: "t_bad_entry",
      purpose: "bad entry test",
      runtime: "python",
      entryCommand: "python3 nonexistent_file.py",
      trigger: "external",
    }))

    // Spawn should succeed (process starts) but registration should time out
    await mgr.spawn("t_bad_entry")
    const registered = await mgr.waitForRegistration("t_bad_entry", 3_000)
    expect(registered).toBe(false)
  }, 15_000)

  it("sends directive kill to a running tentacle", async () => {
    const config = initIntegrationConfig(dir)
    ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()

    const registry = new TentacleRegistry(path.join(dir, "workspace"))
    const queue = new PendingReportsQueue(path.join(dir, "pending.json"))
    mgr = new TentacleManager(config, ipc, registry, queue)

    // Create a tentacle that responds to kill directive
    const tentacleDir = path.join(mgr.getTentacleBaseDir(), "t_killable")
    fs.mkdirSync(tentacleDir, { recursive: true })
    fs.writeFileSync(path.join(tentacleDir, "main.py"), `
import json, os, sys, time, uuid, threading
STOP = False
tid = os.environ.get("OPENCEPH_TENTACLE_ID", "t_killable")
def send(t, payload):
  sys.stdout.write(json.dumps({"type":t,"tentacle_id":tid,"message_id":str(uuid.uuid4()),"timestamp":"x","payload":payload})+"\\n")
  sys.stdout.flush()
def reader():
  global STOP
  for raw in sys.stdin:
    if not raw.strip(): continue
    msg = json.loads(raw)
    if msg.get("type") == "directive" and (msg.get("payload") or {}).get("action") == "kill":
      STOP = True
      break
send("tentacle_register", {"purpose":"killable test","runtime":"python","pid":os.getpid(),"capabilities":{"daemon":[],"agent":[],"consultation":{"mode":"batch"}}})
threading.Thread(target=reader, daemon=True).start()
while not STOP: time.sleep(0.1)
`)
    fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), JSON.stringify({
      tentacleId: "t_killable",
      purpose: "killable test",
      runtime: "python",
      entryCommand: "python3 main.py",
      trigger: "external",
    }))

    await mgr.spawn("t_killable")
    const registered = await mgr.waitForRegistration("t_killable", 10_000)
    expect(registered).toBe(true)

    // Kill the tentacle
    await mgr.kill("t_killable", "test_directive")

    // Wait for process to exit
    await new Promise((r) => setTimeout(r, 1000))
    const status = mgr.getStatus("t_killable")
    expect(["stopped", "killed"]).toContain(status!.status)
  }, 15_000)
})
