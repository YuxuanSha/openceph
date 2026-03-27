import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { SkillLoader } from "../../src/skills/skill-loader.js"
import { SkillSpawner } from "../../src/skills/skill-spawner.js"
import { CodeAgent } from "../../src/code-agent/code-agent.js"
import { TentacleValidator } from "../../src/code-agent/validator.js"
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

  it("generates and deploys a skill tentacle end-to-end", async () => {
    const productDir = path.join(dir, "skills", "producthunt-monitor")
    fs.mkdirSync(path.join(productDir, "scripts"), { recursive: true })
    fs.writeFileSync(path.join(productDir, "SKILL.md"), `---\nname: producthunt-monitor\ndescription: monitor PH\nversion: 1.0.0\nspawnable: true\nruntime: python\nentry: scripts/monitor.py\ndefault_trigger: every 6 hours\n---\n`)
    fs.writeFileSync(path.join(productDir, "scripts", "monitor.py"), `
import json, os, sys, time, uuid
def send(t, payload):
  sys.stdout.write(json.dumps({"type":t,"sender":os.environ["OPENCEPH_TENTACLE_ID"],"receiver":"brain","payload":payload,"timestamp":"x","message_id":str(uuid.uuid4())})+"\\n")
  sys.stdout.flush()
send("tentacle_register", {"purpose":"ph monitor","runtime":"python"})
time.sleep(0.2)
send("report_finding", {"findingId":"ph1","summary":"new launch","confidence":0.9})
while True: time.sleep(1)
`)
    const config = {
      tentacle: { ipcSocketPath: path.join(dir, "sock"), codeGenMaxRetries: 3, crashRestartMaxAttempts: 3 },
      agents: { defaults: { workspace: path.join(dir, "workspace") } },
    } as any
    const ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()
    const queue = new PendingReportsQueue(path.join(dir, "pending.json"))
    const manager = new TentacleManager(config, ipc, new TentacleRegistry(path.join(dir, "workspace")), queue)
    const loader = new SkillLoader([path.join(dir, "skills")])
    const codeAgent = new CodeAgent({} as any, config)
    // Mock generateSkillTentacle to simulate Claude Code generating files
    const tentacleDir = manager.getTentacleDir("t_ph_monitor")
    codeAgent.generateSkillTentacle = vi.fn(async () => {
      fs.mkdirSync(path.join(tentacleDir, "prompt"), { recursive: true })
      fs.mkdirSync(path.join(tentacleDir, "src"), { recursive: true })
      fs.writeFileSync(path.join(tentacleDir, "SKILL.md"), `---\nname: t_ph_monitor\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n---\n`)
      fs.writeFileSync(path.join(tentacleDir, "README.md"), "# ProductHunt Monitor\n## Start Command\n```bash\npython3 src/main.py\n```\n")
      fs.writeFileSync(path.join(tentacleDir, "prompt", "SYSTEM.md"), "# Identity\nYou are a ProductHunt monitor.\n\n# Mission\nMonitor Product Hunt for new AI products.")
      fs.writeFileSync(path.join(tentacleDir, "src", "main.py"), productDir + "/scripts/monitor.py content placeholder")
      return {
        sessionFile: path.join(dir, "claude-session.jsonl"),
        workDir: dir,
        logsDir: path.join(dir, "agent-logs"),
        terminalLog: path.join(dir, "agent-logs", "terminal.log"),
        stdoutLog: path.join(dir, "agent-logs", "stdout.log"),
        stderrLog: path.join(dir, "agent-logs", "stderr.log"),
        elapsedMs: 500,
        turnCount: 1,
        toolCalls: [],
      }
    }) as any
    codeAgent.fixSkillTentacle = vi.fn() as any
    codeAgent.deployExisting = vi.fn().mockResolvedValue(undefined) as any
    // Mock manager spawn/register to avoid real process start
    vi.spyOn(manager, "spawn").mockResolvedValue(undefined)
    vi.spyOn(manager, "waitForRegistration").mockResolvedValue(true)
    vi.spyOn(manager, "getStatus").mockReturnValue({ pid: 99999 } as any)
    // Mock validator to always pass (this test focuses on spawn flow, not contract validation)
    vi.spyOn(TentacleValidator.prototype, "validateSkillTentacle").mockResolvedValue({
      passed: true,
      checks: {
        structure: { passed: true, errors: [], warnings: [] },
        syntax: { passed: true, errors: [], warnings: [] },
        contract: { passed: true, errors: [], warnings: [] },
        security: { passed: true, errors: [], warnings: [] },
        smoke: { passed: true, errors: [], warnings: [] },
      },
    } as any)
    const spawner = new SkillSpawner(config, loader, manager, codeAgent)

    const result = await spawner.spawn({
      mode: "create",
      skillName: "producthunt-monitor",
      tentacleId: "t_ph_monitor",
      purpose: "monitor Product Hunt",
      workflow: "Poll Product Hunt for new AI products every 6 hours",
      userConfirmed: true,
    })
    expect(result.tentacleId).toBe("t_ph_monitor")
    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(tentacleDir, "tentacle.json"))).toBe(true)
    await ipc.stop()
  }, 20_000)
})
