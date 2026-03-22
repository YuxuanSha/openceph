import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { initLoggers } from "../../src/logger/index.js"
import { CodeAgent, CodeAgentAlreadyRunningError, CodeAgentTimeoutError, type CodeAgentRequirement } from "../../src/code-agent/code-agent.js"

class FakeClaudeProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  kill = vi.fn((signal?: NodeJS.Signals | number) => {
    setImmediate(() => this.emit("close", signal === "SIGKILL" ? 137 : 143))
    return true
  })
}

describe("CodeAgent Claude CLI runner", () => {
  let dir: string
  let previousForceFlag: string | undefined

  beforeEach(() => {
    previousForceFlag = process.env.OPENCEPH_CODE_AGENT_FORCE_CLAUDE_CLI
    process.env.OPENCEPH_CODE_AGENT_FORCE_CLAUDE_CLI = "1"

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-code-agent-"))
    initLoggers({
      meta: { version: "3.2" },
      gateway: { port: 18790, bind: "loopback", auth: { mode: "token", token: "x" } },
      agents: { defaults: { workspace: path.join(dir, "workspace"), model: { primary: "anthropic/claude-sonnet-4-5", fallbacks: [] }, userTimezone: "UTC", bootstrapMaxChars: 20000, bootstrapTotalMaxChars: 150000 } },
      models: { providers: {}, named: {} },
      auth: { profiles: {}, order: {}, cooldown: "5m", cacheRetention: "long" },
      channels: { telegram: { enabled: false, dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled", streaming: true, ackReaction: { emoji: "🐙", direct: true }, textChunkLimit: 4000 }, feishu: { enabled: false, proxyMode: "direct", dmPolicy: "pairing", allowFrom: [], domain: "feishu", streaming: false, typingIndicator: true, typingEmoji: "Typing", typingKeepaliveMs: 3000, textChunkLimit: 2000, groupPolicy: "disabled" }, webchat: { enabled: true, port: 18791, auth: { mode: "token" } } },
      mcp: { servers: {}, webSearch: { cacheTtlMinutes: 15 }, webFetch: { maxCharsCap: 50000 } },
      skills: { paths: [] },
      tentacle: { maxActive: 20, ipcSocketPath: path.join(dir, "sock"), codeGenMaxRetries: 1, codeGenTimeoutMs: 1, codeGenPollIntervalMs: 10, codeGenIdleTimeoutMs: 80, crashRestartMaxAttempts: 3, confidenceThresholds: { directReport: 0.8, consultation: 0.4, discard: 0 } },
      push: { defaultTiming: "best_time", preferredWindowStart: "09:00", preferredWindowEnd: "10:00", maxDailyPushes: 3 },
      session: { dmScope: "main", mainKey: "main", reset: { mode: "daily", atHour: 4 }, resetTriggers: ["/new"], cleanup: { maxArchiveFilesPerKey: 30, archiveTtlDays: 90, heartbeatRetentionDays: 7, consultationRetentionDays: 30 } },
      logging: { logDir: path.join(dir, "logs"), level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
      cost: { dailyLimitUsd: 0.5, alertThresholdUsd: 0.4 },
      commands: { config: false, debug: false, bash: false },
      tools: { loopDetection: { enabled: true, warningThreshold: 10, criticalThreshold: 20, historySize: 30, detectors: { genericRepeat: true, knownPollNoProgress: true, pingPong: true } } },
    } as any)
  })

  afterEach(() => {
    if (previousForceFlag === undefined) {
      delete process.env.OPENCEPH_CODE_AGENT_FORCE_CLAUDE_CLI
    } else {
      process.env.OPENCEPH_CODE_AGENT_FORCE_CLAUDE_CLI = previousForceFlag
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("uses local Claude CLI stream-json flow and ignores legacy total timeout when progress continues", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = []
    const fakeSpawn = vi.fn((command: string, args: string[], options: { cwd?: string }) => {
      const proc = new FakeClaudeProcess() as any
      calls.push({ command, args, cwd: options.cwd })

      setTimeout(() => {
        fs.writeFileSync(path.join(options.cwd!, "main.py"), "print('ok')\n", "utf-8")
        proc.stdout.write(JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "claude-session-1",
          model: "claude-sonnet-4-5-20250929",
        }) + "\n")
      }, 5)

      setTimeout(() => {
        proc.stdout.write(JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "tool-1", name: "Write", input: { file_path: path.join(options.cwd!, "main.py") } }],
          },
        }) + "\n")
      }, 20)

      setTimeout(() => {
        proc.stdout.write(JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: false }],
          },
        }) + "\n")
      }, 35)

      setTimeout(() => {
        proc.stdout.write(JSON.stringify({
          type: "result",
          subtype: "success",
          result: "done",
          num_turns: 1,
        }) + "\n")
        proc.emit("close", 0)
      }, 50)

      return proc
    })

    const agent = new CodeAgent({} as any, {
      tentacle: { codeGenPollIntervalMs: 10, codeGenIdleTimeoutMs: 80, codeGenTimeoutMs: 1 },
      models: { named: {} },
    } as any, { spawn: fakeSpawn })

    const requirement: CodeAgentRequirement = {
      tentacleId: "t_cli_progress",
      purpose: "test local claude cli",
      workflow: "write one file",
      capabilities: [],
      reportStrategy: "batch",
      preferredRuntime: "python",
      userContext: "",
    }

    const generated = await agent.generate(requirement)

    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe("claude")
    expect(calls[0].args).toContain("--setting-sources")
    expect(calls[0].args).toContain("local")
    expect(calls[0].args).toContain("bypassPermissions")
    expect(calls[0].args).not.toContain("--no-session-persistence")
    expect(generated.files.map((file) => file.path)).toContain("main.py")
    expect(generated.diagnostics?.toolCalls).toEqual([
      expect.objectContaining({ toolName: "Write", toolCallId: "tool-1", success: true }),
    ])
    expect(generated.diagnostics?.persistentSession).toBe(true)
    expect(generated.diagnostics?.claudeSessionId).toBe("claude-session-1")
    expect(generated.diagnostics?.modelId).toBe("claude-sonnet-4-5-20250929")

    const sessionFile = generated.diagnostics?.sessionFile
    expect(sessionFile).toBeTruthy()
    const sessionLog = fs.readFileSync(sessionFile!, "utf-8")
    expect(sessionLog).toContain("\"provider\":\"claude-code-cli\"")
    expect(sessionLog).toContain("\"modelId\":\"claude-sonnet-4-5-20250929\"")
    expect(sessionLog).toContain("\"persistent_session\":true")
  })

  it("kills the Claude CLI process when idle timeout is exceeded", async () => {
    const fakeSpawn = vi.fn(() => new FakeClaudeProcess() as any)
    const agent = new CodeAgent({} as any, {
      tentacle: { codeGenPollIntervalMs: 10, codeGenIdleTimeoutMs: 25, codeGenTimeoutMs: 1 },
      models: { named: {} },
    } as any, { spawn: fakeSpawn })

    const requirement: CodeAgentRequirement = {
      tentacleId: "t_cli_idle",
      purpose: "test idle timeout",
      workflow: "do nothing",
      capabilities: [],
      reportStrategy: "batch",
      preferredRuntime: "python",
      userContext: "",
    }

    await expect(agent.generate(requirement)).rejects.toBeInstanceOf(CodeAgentTimeoutError)
    const proc = fakeSpawn.mock.results[0]?.value as FakeClaudeProcess
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM")
  })

  it("rejects a second concurrent Claude Code run for the same tentacle", async () => {
    const fakeSpawn = vi.fn((_: string, __: string[], options: { cwd?: string }) => {
      const proc = new FakeClaudeProcess() as any

      setTimeout(() => {
        fs.writeFileSync(path.join(options.cwd!, "main.py"), "print('ok')\n", "utf-8")
        proc.stdout.write(JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "claude-session-exclusive",
          model: "claude-sonnet-4-5-20250929",
        }) + "\n")
      }, 5)

      setTimeout(() => {
        proc.stdout.write(JSON.stringify({
          type: "result",
          subtype: "success",
          result: "done",
          num_turns: 1,
        }) + "\n")
        proc.emit("close", 0)
      }, 40)

      return proc
    })

    const agent = new CodeAgent({} as any, {
      tentacle: { codeGenPollIntervalMs: 10, codeGenIdleTimeoutMs: 80, codeGenTimeoutMs: 1 },
      models: { named: {} },
    } as any, { spawn: fakeSpawn })

    const requirement: CodeAgentRequirement = {
      tentacleId: "t_cli_exclusive",
      purpose: "exclusive local claude cli",
      workflow: "write one file",
      capabilities: [],
      reportStrategy: "batch",
      preferredRuntime: "python",
      userContext: "",
    }

    const first = agent.generate(requirement)
    await expect(agent.generate(requirement)).rejects.toBeInstanceOf(CodeAgentAlreadyRunningError)
    await expect(first).resolves.toBeTruthy()
    expect(fakeSpawn).toHaveBeenCalledTimes(1)
  })
})
