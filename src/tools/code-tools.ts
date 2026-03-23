import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { ToolRegistryEntry } from "./index.js"
import type { OpenCephConfig } from "../config/config-schema.js"
import type { PiContext } from "../pi/pi-context.js"
import { brainLogger } from "../logger/index.js"
import { CodeAgent, CodeAgentAlreadyRunningError, CodeAgentProcessError, CodeAgentTimeoutError, type CodeAgentRequirement } from "../code-agent/code-agent.js"
import { TentacleDeployer } from "../code-agent/deployer.js"
import { TentacleManager } from "../tentacle/manager.js"

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined }
}

export function createCodeTools(opts: {
  config: OpenCephConfig
  piCtx: PiContext
  tentacleManager: TentacleManager
  resolveSessionKey?: (sessionFile: string) => Promise<string | undefined>
}): ToolRegistryEntry[] {
  const agent = new CodeAgent(opts.piCtx, opts.config)
  const deployer = new TentacleDeployer(opts.tentacleManager.getTentacleBaseDir())

  const invokeCodeAgent: ToolDefinition = {
    name: "invoke_code_agent",
    label: "Invoke Code Agent",
    description: "生成并落盘新的触手代码（完整 Agent 系统），不会自动宣称已运行；只有 spawned=true 时才表示已启动",
    parameters: Type.Object({
      tentacle_id: Type.String(),
      purpose: Type.String({ description: "触手使命" }),
      workflow: Type.Optional(Type.String({ description: "工作流描述" })),
      capabilities: Type.Optional(Type.Array(Type.String())),
      report_strategy: Type.Optional(Type.String()),
      infrastructure: Type.Optional(Type.Object({
        needsHttpServer: Type.Optional(Type.Boolean()),
        needsDatabase: Type.Optional(Type.Boolean()),
        needsLlm: Type.Optional(Type.Boolean()),
        needsFileStorage: Type.Optional(Type.Boolean()),
      })),
      external_apis: Type.Optional(Type.Array(Type.String())),
      preferred_runtime: Type.Optional(Type.Union([
        Type.Literal("python"),
        Type.Literal("typescript"),
        Type.Literal("go"),
        Type.Literal("shell"),
        Type.Literal("auto"),
      ])),
    }),
    async execute(_id, params: any, _signal, _onUpdate, ctx) {
      try {
        const sessionFile = ctx.sessionManager.getSessionFile()
        const brainSessionKey = sessionFile
          ? await opts.resolveSessionKey?.(sessionFile)
          : undefined
        const requirement: CodeAgentRequirement = {
          tentacleId: params.tentacle_id,
          purpose: params.purpose,
          workflow: params.workflow ?? params.purpose,
          capabilities: params.capabilities ?? [],
          reportStrategy: params.report_strategy ?? "Report findings in batch when 3+ items accumulated",
          infrastructure: params.infrastructure,
          externalApis: params.external_apis,
          preferredRuntime: params.preferred_runtime ?? "auto",
          userContext: "",
        }

        let generated = await agent.generate(requirement, { brainSessionKey })
        brainLogger.info("code_agent_start", { tentacle_id: params.tentacle_id, brain_session_key: brainSessionKey })
        let directory: string | undefined
        let deployError: string | undefined
        try {
          directory = await deployer.deploy(params.tentacle_id, generated, {
            purpose: requirement.purpose,
            workflow: requirement.workflow,
            capabilities: requirement.capabilities,
            reportStrategy: requirement.reportStrategy,
          })
        } catch (error: any) {
          deployError = error.message
        }

        const deploySucceeded = Boolean(directory)
        await agent.finalizeInvokeCodeAgentRun({
          tentacleId: params.tentacle_id,
          brainSessionKey,
          diagnostics: generated.diagnostics,
          deployed: deploySucceeded,
          deploySucceeded,
          spawned: false,
        })

        brainLogger.info("code_agent_success", { tentacle_id: params.tentacle_id, runtime: generated.runtime, directory })
        return ok(JSON.stringify({
          success: deploySucceeded,
          tentacle_id: params.tentacle_id,
          runtime: generated.runtime,
          entry_command: generated.entryCommand,
          setup_commands: generated.setupCommands,
          dependencies: generated.dependencies,
          directory,
          deployed: Boolean(directory),
          spawned: false,
          runtime_status: "not_running",
          requires_explicit_run_confirmation: true,
          next_step: "代码已生成/部署；如需运行，必须再执行显式 spawn 或 manage_tentacle resume/run_now，并检查 spawned/running 状态。",
          description: generated.description,
          reused_previous_session: generated.diagnostics?.reusedPreviousSession ?? false,
          reuse_reason: generated.diagnostics?.reuseReason ?? "new_session",
          previous_claude_session_id: generated.diagnostics?.resumedFromClaudeSessionId,
          current_claude_session_id: generated.diagnostics?.claudeSessionId,
          brain_session_key: brainSessionKey,
          claude_final_text: generated.diagnostics?.finalText ?? generated.description,
          claude_session_id: generated.diagnostics?.claudeSessionId,
          claude_model_id: generated.diagnostics?.modelId,
          claude_result_subtype: generated.diagnostics?.resultSubtype,
          code_agent_session_file: generated.diagnostics?.sessionFile,
          code_agent_work_dir: generated.diagnostics?.workDir,
          code_agent_log_dir: generated.diagnostics?.logsDir,
          code_agent_terminal_log: generated.diagnostics?.terminalLog,
          code_agent_stdout_log: generated.diagnostics?.stdoutLog,
          code_agent_stderr_log: generated.diagnostics?.stderrLog,
          generated_files: generated.files.map((file) => ({
            path: file.path,
            location: directory ? `${directory}/${file.path}` : undefined,
          })),
          errors: deployError ? [`部署失败: ${deployError}`] : [],
        }, null, 2))
      } catch (error: any) {
        if (
          error instanceof CodeAgentTimeoutError
          || error instanceof CodeAgentProcessError
          || error instanceof CodeAgentAlreadyRunningError
        ) {
          return ok(JSON.stringify({
            success: false,
            tentacle_id: params.tentacle_id,
            error: error.message,
            code_agent_session_file: error.sessionFile,
          }, null, 2))
        }
        return ok(`Code generation failed: ${error.message}`)
      }
    },
  }

  return [
    { name: "invoke_code_agent", description: invokeCodeAgent.description, group: "code", tool: invokeCodeAgent },
  ]
}
