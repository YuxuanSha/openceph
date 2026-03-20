import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { SkillLoader } from "../../src/skills/skill-loader.js"
import { SkillSpawner } from "../../src/skills/skill-spawner.js"
import { IpcServer } from "../../src/tentacle/ipc-server.js"
import { TentacleRegistry } from "../../src/tentacle/registry.js"
import { PendingReportsQueue } from "../../src/tentacle/pending-reports.js"
import { TentacleManager } from "../../src/tentacle/manager.js"

describe("integration: skill spawn", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-skill-spawn-"))
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true })
    fs.writeFileSync(path.join(dir, "workspace", "TENTACLES.md"), "# TENTACLES.md\n")
    initLoggers({
      meta: { version: "3.2" },
      gateway: { port: 18790, bind: "loopback", auth: { mode: "token", token: "x" } },
      agents: { defaults: { workspace: path.join(dir, "workspace"), model: { primary: "anthropic/claude-sonnet-4-5", fallbacks: [] }, userTimezone: "UTC", bootstrapMaxChars: 20000, bootstrapTotalMaxChars: 150000 } },
      models: { providers: {} },
      auth: { profiles: {}, order: {}, cooldown: "5m", cacheRetention: "long" },
      channels: { telegram: { enabled: false, dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled", streaming: true, ackReaction: { emoji: "🐙", direct: true }, textChunkLimit: 4000 }, feishu: { enabled: false, dmPolicy: "pairing", allowFrom: [], domain: "feishu", streaming: true, groupPolicy: "disabled" }, webchat: { enabled: true, port: 18791, auth: { mode: "token" } } },
      mcp: { servers: {}, webSearch: { cacheTtlMinutes: 15 }, webFetch: { maxCharsCap: 50000 } },
      skills: { paths: [path.join(dir, "skills")] },
      tentacle: { maxActive: 20, ipcSocketPath: path.join(dir, "sock"), codeGenMaxRetries: 3, crashRestartMaxAttempts: 3, confidenceThresholds: { directReport: 0.8, consultation: 0.4, discard: 0 } },
      push: { defaultTiming: "best_time", preferredWindowStart: "09:00", preferredWindowEnd: "10:00", maxDailyPushes: 3 },
      session: { dmScope: "main", mainKey: "main", reset: { mode: "daily", atHour: 4 }, resetTriggers: ["/new"], cleanup: { maxArchiveFilesPerKey: 30, archiveTtlDays: 90, heartbeatRetentionDays: 7, consultationRetentionDays: 30 } },
      logging: { logDir: path.join(dir, "logs"), level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
      cost: { dailyLimitUsd: 0.5, alertThresholdUsd: 0.4 },
      commands: { config: false, debug: false, bash: false },
      tools: { loopDetection: { enabled: true, warningThreshold: 10, criticalThreshold: 20, historySize: 30, detectors: { genericRepeat: true, knownPollNoProgress: true, pingPong: true } } },
    } as any)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("spawns a skill tentacle end-to-end", async () => {
    const productDir = path.join(dir, "skills", "producthunt-monitor")
    fs.mkdirSync(path.join(productDir, "scripts"), { recursive: true })
    fs.writeFileSync(path.join(productDir, "SKILL.md"), `---\nname: producthunt-monitor\ndescription: monitor PH\nversion: 1.0.0\nspawnable: true\nruntime: python\nentry: scripts/monitor.py\ndefault_trigger: every 6 hours\n---\n`)
    fs.writeFileSync(path.join(productDir, "scripts", "monitor.py"), `
import json, os, socket, time, uuid
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["OPENCEPH_SOCKET_PATH"])
def send(t, payload):
  sock.sendall((json.dumps({"type":t,"sender":os.environ["OPENCEPH_TENTACLE_ID"],"receiver":"brain","payload":payload,"timestamp":"x","message_id":str(uuid.uuid4())})+"\\n").encode("utf-8"))
send("tentacle_register", {"purpose":"ph monitor","runtime":"python"})
time.sleep(0.2)
send("report_finding", {"findingId":"ph1","summary":"new launch","confidence":0.9})
while True: time.sleep(1)
`)
    const ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()
    const queue = new PendingReportsQueue(path.join(dir, "pending.json"))
    const manager = new TentacleManager({ tentacle: { ipcSocketPath: path.join(dir, "sock"), crashRestartMaxAttempts: 3 } } as any, ipc, new TentacleRegistry(path.join(dir, "workspace")), queue)
    const spawner = new SkillSpawner({ tentacle: { ipcSocketPath: path.join(dir, "sock") } } as any, new SkillLoader([path.join(dir, "skills")]), manager, { python3: true, node: true, go: false, bash: true })
    await spawner.spawn("producthunt-monitor", "t_ph_monitor")
    expect(await manager.waitForRegistration("t_ph_monitor", 3000)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await queue.size()).toBe(1)
    await manager.kill("t_ph_monitor", "done")
    await ipc.stop()
  })
})
