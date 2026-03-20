import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { CodeAgent } from "../../src/code-agent/code-agent.js"
import { TentacleValidator } from "../../src/code-agent/validator.js"
import { TentacleDeployer } from "../../src/code-agent/deployer.js"
import { IpcServer } from "../../src/tentacle/ipc-server.js"
import { TentacleRegistry } from "../../src/tentacle/registry.js"
import { PendingReportsQueue } from "../../src/tentacle/pending-reports.js"
import { TentacleManager } from "../../src/tentacle/manager.js"

describe("integration: code agent", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-code-agent-"))
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
      skills: { paths: [] },
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

  it("generates, validates, deploys and starts a tentacle", async () => {
    const agent = new CodeAgent({} as any, {} as any)
    const code = await agent.generate({
      tentacleId: "t_generated",
      purpose: "monitor github commits",
      triggerCondition: "manual",
      dataSources: ["github"],
      outputFormat: "summary",
      preferredRuntime: "python",
    })
    const validation = await new TentacleValidator().validateAll(code)
    expect(validation.valid).toBe(true)

    const deployer = new TentacleDeployer(path.join(dir, "tentacles"))
    const targetDir = await deployer.deploy("t_generated", code, { purpose: "monitor github commits", trigger: "manual", dataSources: ["github"] })
    expect(fs.existsSync(path.join(targetDir, "tentacle.json"))).toBe(true)

    const ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()
    const manager = new TentacleManager({ tentacle: { ipcSocketPath: path.join(dir, "sock"), crashRestartMaxAttempts: 3 } } as any, ipc, new TentacleRegistry(path.join(dir, "workspace")), new PendingReportsQueue(path.join(dir, "pending.json")))
    const metadata = JSON.parse(fs.readFileSync(path.join(targetDir, "tentacle.json"), "utf-8"))
    metadata.cwd = targetDir
    metadata.entryCommand = code.entryCommand
    fs.writeFileSync(path.join(targetDir, "tentacle.json"), JSON.stringify(metadata))
    await manager.spawn("t_generated")
    expect(await manager.waitForRegistration("t_generated", 3000)).toBe(true)
    await manager.kill("t_generated", "done")
    await ipc.stop()
  })
})
