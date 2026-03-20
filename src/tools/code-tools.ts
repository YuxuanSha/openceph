import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { ToolRegistryEntry } from "./index.js"
import type { OpenCephConfig } from "../config/config-schema.js"
import type { PiContext } from "../pi/pi-context.js"
import { brainLogger } from "../logger/index.js"
import { CodeAgent, type CodeAgentRequirement } from "../code-agent/code-agent.js"
import { TentacleValidator } from "../code-agent/validator.js"
import { TentacleDeployer } from "../code-agent/deployer.js"
import { TentacleManager } from "../tentacle/manager.js"

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined }
}

export function createCodeTools(opts: {
  config: OpenCephConfig
  piCtx: PiContext
  tentacleManager: TentacleManager
}): ToolRegistryEntry[] {
  const agent = new CodeAgent(opts.piCtx, opts.config)
  const validator = new TentacleValidator()
  const deployer = new TentacleDeployer(opts.tentacleManager.getTentacleBaseDir())

  const invokeCodeAgent: ToolDefinition = {
    name: "invoke_code_agent",
    label: "Invoke Code Agent",
    description: "生成、校验并部署新的触手代码",
    parameters: Type.Object({
      tentacle_id: Type.String(),
      requirement: Type.String({ description: "触手需求完整描述" }),
      preferred_runtime: Type.Optional(Type.Union([
        Type.Literal("python"),
        Type.Literal("typescript"),
        Type.Literal("go"),
        Type.Literal("shell"),
      ])),
      context: Type.Optional(Type.Object({
        existing_examples: Type.Optional(Type.Array(Type.String())),
        special_requirements: Type.Optional(Type.String()),
      })),
    }),
    async execute(_id, params: any) {
      const requirement = parseRequirement(params)
      const retries = Math.max(1, opts.config.tentacle.codeGenMaxRetries)
      let lastError = "unknown error"
      brainLogger.info("code_agent_start", { tentacle_id: params.tentacle_id, preferred_runtime: params.preferred_runtime ?? "auto" })

      for (let attempt = 1; attempt <= retries; attempt++) {
        const generated = await agent.generate(requirement)
        const validation = await validator.validateAll(generated)
        if (!validation.valid) {
          lastError = validation.errors.join("; ")
          continue
        }

        const directory = await deployer.deploy(params.tentacle_id, generated, {
          purpose: requirement.purpose,
          trigger: requirement.triggerCondition,
          dataSources: requirement.dataSources,
        })
        await opts.tentacleManager.spawn(params.tentacle_id)
        brainLogger.info("code_agent_success", { tentacle_id: params.tentacle_id, runtime: generated.runtime })
        return ok(JSON.stringify({
          success: true,
          tentacle_id: params.tentacle_id,
          runtime: generated.runtime,
          entry_command: generated.entryCommand,
          directory,
          warnings: validation.warnings,
        }, null, 2))
      }

      brainLogger.error("code_agent_failed", { tentacle_id: params.tentacle_id, error: lastError })
      return ok(`Code generation failed: ${lastError}`)
    },
  }

  const createTentacle: ToolDefinition = {
    name: "create_tentacle",
    label: "Create Tentacle",
    description: "根据结构化需求生成新的触手",
    parameters: Type.Object({
      tentacle_id: Type.String(),
      purpose: Type.String(),
      trigger_condition: Type.String(),
      data_sources: Type.Array(Type.String()),
      output_format: Type.String(),
      preferred_runtime: Type.Optional(Type.Union([
        Type.Literal("python"),
        Type.Literal("typescript"),
        Type.Literal("go"),
        Type.Literal("shell"),
        Type.Literal("auto"),
      ])),
      ask_user_confirm: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_id, params: any) {
      const requirement: CodeAgentRequirement = {
        tentacleId: params.tentacle_id,
        purpose: params.purpose,
        triggerCondition: params.trigger_condition,
        dataSources: params.data_sources,
        outputFormat: params.output_format,
        preferredRuntime: params.preferred_runtime ?? "auto",
      }

      const generated = await agent.generate(requirement)
      const validation = await validator.validateAll(generated)
      if (!validation.valid) {
        return ok(`Code generation failed validation: ${validation.errors.join("; ")}`)
      }
      const directory = await deployer.deploy(params.tentacle_id, generated, {
        purpose: params.purpose,
        trigger: params.trigger_condition,
        dataSources: params.data_sources,
      })
      await opts.tentacleManager.spawn(params.tentacle_id)
      return ok(JSON.stringify({
        success: true,
        tentacle_id: params.tentacle_id,
        runtime: generated.runtime,
        directory,
      }, null, 2))
    },
  }

  return [
    { name: "invoke_code_agent", description: invokeCodeAgent.description, group: "code", tool: invokeCodeAgent },
    { name: "create_tentacle", description: createTentacle.description, group: "code", tool: createTentacle },
  ]
}

function parseRequirement(params: any): CodeAgentRequirement {
  return {
    tentacleId: params.tentacle_id,
    purpose: params.requirement,
    triggerCondition: "manual",
    dataSources: [],
    outputFormat: "summary",
    preferredRuntime: params.preferred_runtime ?? "auto",
    context: params.context ? {
      existingExamples: params.context.existing_examples,
      specialRequirements: params.context.special_requirements,
    } : undefined,
  }
}
