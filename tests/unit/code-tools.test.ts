import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createCodeTools } from "../../src/tools/code-tools.js"
import { CodeAgent } from "../../src/code-agent/code-agent.js"
import { TentacleDeployer } from "../../src/code-agent/deployer.js"
import { initLoggers } from "../../src/logger/index.js"

describe("invoke_code_agent tool", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns success false when deploy fails and includes reuse metadata", async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-code-tools-log-"))
    initLoggers({
      logging: { logDir, level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    } as any)
    vi.spyOn(CodeAgent.prototype, "generate").mockResolvedValue({
      runtime: "python",
      files: [{ path: "main.py", content: "print('ok')\n" }],
      entryCommand: "python3 main.py",
      setupCommands: [],
      description: "generated",
      diagnostics: {
        sessionFile: "/tmp/ca-session.jsonl",
        workDir: "/tmp/ca-work",
        elapsedMs: 10,
        turnCount: 1,
        toolCalls: [],
        finalText: "generated",
        claudeSessionId: "claude-current",
        resumedFromClaudeSessionId: "claude-prev",
        reusedPreviousSession: true,
        reuseReason: "same_brain_session_same_tentacle_reusable_candidate",
        brainSessionKey: "agent:ceph:main",
      },
    } as any)
    const finalizeSpy = vi.spyOn(CodeAgent.prototype, "finalizeInvokeCodeAgentRun").mockResolvedValue(undefined)
    vi.spyOn(TentacleDeployer.prototype, "deploy").mockRejectedValue(new Error("pip install failed"))

    const tools = createCodeTools({
      config: {} as any,
      piCtx: {} as any,
      tentacleManager: { getTentacleBaseDir: () => "/tmp/tentacles" } as any,
      resolveSessionKey: async () => "agent:ceph:main",
    })
    const tool = tools.find((entry) => entry.name === "invoke_code_agent")!.tool

    const result = await tool.execute(
      "tool-1",
      {
        tentacle_id: "t_test",
        purpose: "test",
        workflow: "test workflow",
        preferred_runtime: "python",
      },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionFile: () => "/tmp/brain-session.jsonl",
        },
      } as any,
    )

    const payload = JSON.parse(result.content[0].text)
    expect(payload.success).toBe(false)
    expect(payload.errors).toEqual(["部署失败: pip install failed"])
    expect(payload.reused_previous_session).toBe(true)
    expect(payload.previous_claude_session_id).toBe("claude-prev")
    expect(payload.current_claude_session_id).toBe("claude-current")
    expect(payload.brain_session_key).toBe("agent:ceph:main")
    expect(finalizeSpy).toHaveBeenCalledWith(expect.objectContaining({
      tentacleId: "t_test",
      brainSessionKey: "agent:ceph:main",
      deployed: false,
      deploySucceeded: false,
      spawned: false,
    }))
  })
})
