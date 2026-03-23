import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
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
    const generate = vi.fn(async () => ({
      runtime: "python",
      files: [
        { path: "main.py", content: "print('ok')\n" },
        { path: "README.md", content: "# generated\n" },
      ],
      entryCommand: "python3 main.py",
      setupCommands: [],
      dependencies: undefined,
      envVars: ["OPENCEPH_TENTACLE_ID", "OPENCEPH_TRIGGER_MODE"],
      description: "generated tentacle",
      diagnostics: {
        sessionFile: path.join(dir, "claude-session.jsonl"),
        workDir: path.join(dir, "claude-work"),
        elapsedMs: 1234,
        turnCount: 2,
        toolCalls: [],
        finalText: "Claude finished successfully",
        claudeSessionId: "claude-session-1",
        modelId: "claude-sonnet-4-5-20250929",
        resultSubtype: "success",
        persistentSession: true,
      },
    }))
    const spawner = new SkillSpawner(config, loader, manager, { generate } as any)

    const result = await spawner.spawn({
      skillName: "demo",
      tentacleId: "t_demo",
      purpose: "demo skill test",
      workflow: "test workflow",
      userConfirmed: true,
    })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.tentacleId).toBe("t_demo")
    expect(result.spawned).toBe(false)
    expect(result.deployed).toBe(true)
    expect(result.claudeFinalText).toBe("Claude finished successfully")
    expect(result.claudeSessionId).toBe("claude-session-1")
    expect(result.files).toEqual(["main.py", "README.md"])
    expect(result.generatedFiles?.map((file) => file.path)).toEqual(["main.py", "README.md"])
    expect(fs.existsSync(path.join(manager.getTentacleDir("t_demo"), "tentacle.json"))).toBe(true)
    await ipc.stop()
  }, 20_000)
})
