import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { SkillLoader } from "../../src/skills/skill-loader.js"
import { SkillSpawner } from "../../src/skills/skill-spawner.js"
import { TentacleValidator } from "../../src/code-agent/validator.js"
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

  it("runs Claude Code once and returns generated result immediately", async () => {
    const skillDir = path.join(dir, "skills", "demo")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: demo\ndescription: test skill\nversion: 1.0.0\nspawnable: true\nruntime: python\nentry: main.py\ndefault_trigger: manual\n---\n`)
    fs.writeFileSync(path.join(skillDir, "main.py"), "print('template')\n")

    const config = {
      tentacle: { ipcSocketPath: path.join(dir, "sock"), codeGenMaxRetries: 3, crashRestartMaxAttempts: 3 },
      agents: { defaults: { workspace: path.join(dir, "workspace") } },
    } as any
    const ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()
    const manager = new TentacleManager(
      config,
      ipc,
      new TentacleRegistry(path.join(dir, "workspace")),
      new PendingReportsQueue(path.join(dir, "pending.json")),
    )
    const loader = new SkillLoader([path.join(dir, "skills")])
    // Create tentacle dir structure so validator can find files after generation
    const tentacleDir = path.join(manager.getTentacleDir("t_demo"))
    fs.mkdirSync(path.join(tentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(tentacleDir, "src"), { recursive: true })

    const generateSkillTentacle = vi.fn(async () => {
      // Simulate Claude Code writing files to the tentacle dir
      fs.writeFileSync(path.join(tentacleDir, "SKILL.md"), "---\nname: t_demo\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n---\n")
      fs.writeFileSync(path.join(tentacleDir, "README.md"), "# generated\n## Start Command\n```bash\npython3 src/main.py\n```\n")
      fs.writeFileSync(path.join(tentacleDir, "prompt", "SYSTEM.md"), "# Identity\nYou are t_demo.\n\n# Mission\nGenerated tentacle for testing.")
      fs.writeFileSync(path.join(tentacleDir, "src", "main.py"), "print('ok')\n")
      return {
        sessionFile: path.join(dir, "claude-session.jsonl"),
        workDir: path.join(dir, "claude-work"),
        logsDir: path.join(dir, "agent-logs"),
        terminalLog: path.join(dir, "agent-logs", "terminal.log"),
        stdoutLog: path.join(dir, "agent-logs", "stdout.log"),
        stderrLog: path.join(dir, "agent-logs", "stderr.log"),
        elapsedMs: 1234,
        turnCount: 2,
        toolCalls: [],
      }
    })
    const fixSkillTentacle = vi.fn()
    const deployExisting = vi.fn()
    // Mock manager spawn/register to avoid real process start
    vi.spyOn(manager, "spawn").mockResolvedValue(undefined)
    vi.spyOn(manager, "waitForRegistration").mockResolvedValue(true)
    vi.spyOn(manager, "getStatus").mockReturnValue({ pid: 12345 } as any)

    const spawner = new SkillSpawner(config, loader, manager, { generateSkillTentacle, fixSkillTentacle, deployExisting } as any)

    // Mock validator to always pass (this test focuses on routing, not contract validation)
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

    const result = await spawner.spawn({
      mode: "create",
      skillName: "demo",
      tentacleId: "t_demo",
      purpose: "demo skill test",
      workflow: "test workflow",
      userConfirmed: true,
    })
    expect(generateSkillTentacle).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.tentacleId).toBe("t_demo")
    expect(fs.existsSync(path.join(manager.getTentacleDir("t_demo"), "tentacle.json"))).toBe(true)
    await ipc.stop()
  }, 20_000)
})
