import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { IpcServer } from "../../src/tentacle/ipc-server.js"
import { TentacleRegistry } from "../../src/tentacle/registry.js"
import { PendingReportsQueue } from "../../src/tentacle/pending-reports.js"
import { TentacleManager } from "../../src/tentacle/manager.js"

describe("TentacleManager", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-tm-"))
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
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true })
    fs.writeFileSync(path.join(dir, "workspace", "TENTACLES.md"), "# TENTACLES.md\n")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("spawns, pauses, resumes and kills a tentacle", async () => {
    const ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()
    const manager = new TentacleManager(
      {
        tentacle: { ipcSocketPath: path.join(dir, "sock"), crashRestartMaxAttempts: 3 },
      } as any,
      ipc,
      new TentacleRegistry(path.join(dir, "workspace")),
      new PendingReportsQueue(path.join(dir, "pending.json")),
    )

    const tentacleDir = manager.getTentacleDir("t1")
    fs.mkdirSync(tentacleDir, { recursive: true })
    fs.writeFileSync(path.join(tentacleDir, "register.mjs"), `
      import * as readline from 'node:readline';
      process.stderr.write('booting\\n');
      process.stdout.write(JSON.stringify({type:'tentacle_register',sender:'t1',receiver:'brain',payload:{purpose:'test',runtime:'node'},timestamp:new Date().toISOString(),message_id:'1'})+'\\n');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.type === 'directive' && msg.payload?.action === 'kill') process.exit(0);
      });
      setInterval(() => {}, 1000);
    `)
    fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), JSON.stringify({
      tentacleId: "t1",
      purpose: "test",
      runtime: "node",
      entryCommand: "node register.mjs",
      cwd: tentacleDir,
    }))

    await manager.spawn("t1")
    expect(await manager.waitForRegistration("t1", 3000)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(manager.getStatus("t1")?.status).toBe("running")
    expect(fs.readFileSync(path.join(tentacleDir, "logs", "stdout.log"), "utf-8")).toContain("tentacle_register")
    expect(fs.readFileSync(path.join(tentacleDir, "logs", "stderr.log"), "utf-8")).toContain("booting")
    expect(fs.readFileSync(path.join(tentacleDir, "logs", "terminal.log"), "utf-8")).toContain("[stderr] booting")
    expect(await manager.pause("t1")).toBe(true)
    expect(manager.getStatus("t1")?.status).toBe("paused")
    expect(await manager.resume("t1")).toBe(true)
    expect(manager.getStatus("t1")?.status).toBe("running")
    expect(await manager.weaken("t1", "test")).toBe(true)
    expect(manager.getStatus("t1")?.status).toBe("weakened")
    expect(await manager.kill("t1", "test")).toBe(true)
    expect(manager.getStatus("t1")?.status).toBe("killed")
    await ipc.stop()
  })

  it("injects model runtime env from openceph.json-style config into tentacles", async () => {
    const socketPath = path.join(dir, "sock-model")
    const ipc = new IpcServer(socketPath)
    await ipc.start()
    const manager = new TentacleManager(
      {
        agents: {
          defaults: {
            workspace: path.join(dir, "workspace"),
            model: { primary: "openrouter/anthropic/claude-opus-4-6", fallbacks: [] },
            models: {
              "openrouter/anthropic/claude-opus-4-6": {
                params: { temperature: 0.4 },
              },
            },
          },
        },
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
            },
          },
          named: {},
        },
        auth: {
          profiles: {
            "openrouter:primary": {
              mode: "api_key",
              apiKey: "sk-runtime-value",
            },
          },
          order: {
            openrouter: ["openrouter:primary"],
          },
        },
        tentacle: { ipcSocketPath: socketPath, crashRestartMaxAttempts: 3 },
      } as any,
      ipc,
      new TentacleRegistry(path.join(dir, "workspace")),
      new PendingReportsQueue(path.join(dir, "pending.json")),
    )

    const tentacleDir = manager.getTentacleDir("t_model_env")
    const dumpPath = path.join(tentacleDir, "env.json")
    fs.mkdirSync(tentacleDir, { recursive: true })
    fs.writeFileSync(path.join(tentacleDir, "register.mjs"), `
      import * as fs from 'node:fs';
      import * as readline from 'node:readline';
      fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({
        openrouterKey: process.env.OPENROUTER_API_KEY,
        openrouterModel: process.env.OPENROUTER_MODEL,
        llmBaseUrl: process.env.OPENCEPH_LLM_BASE_URL,
        llmModel: process.env.OPENCEPH_LLM_MODEL,
        llmParams: process.env.OPENCEPH_LLM_PARAMS_JSON,
      }, null, 2));
      process.stdout.write(JSON.stringify({type:'tentacle_register',sender:'t_model_env',receiver:'brain',payload:{purpose:'test',runtime:'node'},timestamp:new Date().toISOString(),message_id:'1'})+'\\n');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.type === 'directive' && msg.payload?.action === 'kill') process.exit(0);
      });
      setInterval(() => {}, 1000);
    `)
    fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), JSON.stringify({
      tentacleId: "t_model_env",
      purpose: "test",
      runtime: "node",
      entryCommand: "node register.mjs",
      cwd: tentacleDir,
    }))

    await manager.spawn("t_model_env")
    expect(await manager.waitForRegistration("t_model_env", 3000)).toBe(true)

    const envDump = JSON.parse(fs.readFileSync(dumpPath, "utf-8"))
    expect(envDump.openrouterKey).toBe("sk-runtime-value")
    expect(envDump.openrouterModel).toBe("anthropic/claude-opus-4-6")
    expect(envDump.llmBaseUrl).toBe("https://openrouter.ai/api/v1")
    expect(envDump.llmModel).toBe("anthropic/claude-opus-4-6")
    expect(envDump.llmParams).toBe("{\"temperature\":0.4}")

    expect(await manager.kill("t_model_env", "test")).toBe(true)
    await ipc.stop()
  })

  it("resumes a known tentacle by spawning it again when no process is running", async () => {
    const socketPath = path.join(dir, "sock-resume")
    const ipc = new IpcServer(socketPath)
    await ipc.start()
    const manager = new TentacleManager(
      {
        tentacle: { ipcSocketPath: socketPath, crashRestartMaxAttempts: 3 },
      } as any,
      ipc,
      new TentacleRegistry(path.join(dir, "workspace")),
      new PendingReportsQueue(path.join(dir, "pending.json")),
    )

    const tentacleDir = manager.getTentacleDir("t_resume")
    fs.mkdirSync(tentacleDir, { recursive: true })
    fs.writeFileSync(path.join(tentacleDir, "register.mjs"), `
      import * as readline from 'node:readline';
      process.stdout.write(JSON.stringify({type:'tentacle_register',sender:'t_resume',receiver:'brain',payload:{purpose:'resume-test',runtime:'node'},timestamp:new Date().toISOString(),message_id:'1'})+'\\n');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.type === 'directive' && msg.payload?.action === 'kill') process.exit(0);
      });
      setInterval(() => {}, 1000);
    `)
    fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), JSON.stringify({
      tentacleId: "t_resume",
      purpose: "resume-test",
      runtime: "node",
      entryCommand: "node register.mjs",
      cwd: tentacleDir,
    }))

    await manager.spawn("t_resume")
    expect(await manager.waitForRegistration("t_resume", 3000)).toBe(true)
    expect(await manager.kill("t_resume", "test")).toBe(true)
    expect(manager.getStatus("t_resume")?.status).toBe("killed")

    expect(await manager.resume("t_resume")).toBe(true)
    expect(await manager.waitForRegistration("t_resume", 3000)).toBe(true)
    expect(manager.getStatus("t_resume")?.status).toBe("running")

    await manager.kill("t_resume", "cleanup")
    await ipc.stop()
  })
})
