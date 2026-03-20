import { describe, it, expect, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as net from "net"
import { initLoggers } from "../../src/logger/index.js"
import { IpcServer } from "../../src/tentacle/ipc-server.js"

describe("IpcServer", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
  })

  it("handles jsonl fragmentation and register/disconnect", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-ipc-"))
    tempDirs.push(dir)
    initLoggers({
      meta: { version: "3.2" },
      gateway: { port: 18790, bind: "loopback", auth: { mode: "token", token: "x" } },
      agents: { defaults: { workspace: dir, model: { primary: "anthropic/claude-sonnet-4-5", fallbacks: [] }, userTimezone: "UTC", bootstrapMaxChars: 20000, bootstrapTotalMaxChars: 150000 } },
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

    const server = new IpcServer(path.join(dir, "sock"))
    const received: string[] = []
    server.onMessage(async (_id, message) => {
      received.push(message.type)
    })
    await server.start()

    const socket = net.createConnection(path.join(dir, "sock"))
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
    socket.write('{"type":"tentacle_register","sender":"t1","receiver":"brain","payload":{},"timestamp":"x","message_id":"1"}')
    socket.write('\n{"type":"report_finding","sender":"t1","receiver":"brain","payload":{},"timestamp":"x","message_id":"2"}\n')
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(received).toEqual(["tentacle_register", "report_finding"])
    expect(server.getConnectedTentacles()).toContain("t1")

    socket.end()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await server.stop()
  })
})
