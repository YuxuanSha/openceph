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

describe("SkillSpawner", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-spawner-"))
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

  it("copies a spawnable skill and starts it", async () => {
    const skillDir = path.join(dir, "skills", "demo")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: demo\ndescription: test skill\nversion: 1.0.0\nspawnable: true\nruntime: python\nentry: main.py\ndefault_trigger: manual\n---\n`)
    fs.writeFileSync(path.join(skillDir, "main.py"), `
import json, os, socket, time, uuid
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["OPENCEPH_SOCKET_PATH"])
sock.sendall((json.dumps({"type":"tentacle_register","sender":os.environ["OPENCEPH_TENTACLE_ID"],"receiver":"brain","payload":{"purpose":"demo","runtime":"python"},"timestamp":"x","message_id":str(uuid.uuid4())})+"\\n").encode("utf-8"))
while True: time.sleep(1)
`)

    const ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()
    const manager = new TentacleManager(
      { tentacle: { ipcSocketPath: path.join(dir, "sock"), crashRestartMaxAttempts: 3 } } as any,
      ipc,
      new TentacleRegistry(path.join(dir, "workspace")),
      new PendingReportsQueue(path.join(dir, "pending.json")),
    )
    const loader = new SkillLoader([path.join(dir, "skills")])
    const spawner = new SkillSpawner({ tentacle: { ipcSocketPath: path.join(dir, "sock") } } as any, loader, manager, { python3: true, node: true, go: false, bash: true })

    const result = await spawner.spawn("demo", "t_demo")
    expect(result.tentacleId).toBe("t_demo")
    expect(await manager.waitForRegistration("t_demo", 3000)).toBe(true)
    expect(fs.existsSync(path.join(manager.getTentacleDir("t_demo"), "tentacle.json"))).toBe(true)
    await manager.kill("t_demo", "done")
    await ipc.stop()
  })
})
