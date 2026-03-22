import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import type { OpenCephConfig } from "../config/config-schema.js"
import { brainLogger, systemLogger } from "../logger/index.js"
import {
  CodeAgentAlreadyRunningError,
  CodeAgent,
  CodeAgentProcessError,
  CodeAgentTimeoutError,
  type CodeAgentRequirement,
} from "../code-agent/code-agent.js"
import { TentacleDeployer } from "../code-agent/deployer.js"
import { SkillLoader } from "./skill-loader.js"
import { SkillInspector } from "./skill-inspector.js"
import { TentacleManager } from "../tentacle/manager.js"
import type { TentacleCapability } from "../tentacle/contract.js"
import { parseDurationMs } from "../cron/time.js"

export interface SpawnParams {
  skillName?: string
  tentacleId: string
  purpose: string
  workflow: string
  capabilities?: TentacleCapability[]
  reportStrategy?: string
  infrastructure?: CodeAgentRequirement["infrastructure"]
  externalApis?: string[]
  preferredRuntime?: string
  userConfirmed: boolean
}

export interface SpawnResult {
  success: boolean
  tentacleId?: string
  skillName?: string
  runtime?: string
  directory?: string
  trigger?: string
  description?: string
  errors?: string[]
  pid?: number
  files?: string[]
  generatedFiles?: Array<{
    path: string
    location?: string
  }>
  entryCommand?: string
  setupCommands?: string[]
  dependencies?: string
  deployed?: boolean
  spawned?: boolean
  claudeFinalText?: string
  claudeSessionId?: string
  claudeModelId?: string
  claudeResultSubtype?: string
  codeAgentSessionFile?: string
  codeAgentWorkDir?: string
}

export class SkillSpawner {
  private codeAgent: CodeAgent
  private deployer: TentacleDeployer

  constructor(
    private config: OpenCephConfig,
    private skillLoader: SkillLoader,
    private tentacleManager: TentacleManager,
    codeAgent: CodeAgent,
  ) {
    this.codeAgent = codeAgent
    this.deployer = new TentacleDeployer(tentacleManager.getTentacleBaseDir())
  }

  /**
   * Unified spawn entry point.
   * - With skillName: loads SKILL blueprint as context, then generates via CodeAgent
   * - Without skillName: generates from scratch via CodeAgent
   * - Uses exactly one Claude Code run, deploys generated files, returns immediately
   */
  async spawn(params: SpawnParams): Promise<SpawnResult> {
    await this.skillLoader.loadAll()

    systemLogger.info("spawn_start", {
      tentacle_id: params.tentacleId,
      skill_name: params.skillName ?? "none",
      purpose: params.purpose,
    })
    brainLogger.info("spawn_start", {
      tentacle_id: params.tentacleId,
      skill_name: params.skillName ?? "none",
    })

    // 1. Build CodeAgentRequirement
    let requirement: CodeAgentRequirement
    try {
      requirement = await this.buildRequirement(params)
    } catch (error: any) {
      brainLogger.error("spawn_requirement_failed", {
        tentacle_id: params.tentacleId,
        skill_name: params.skillName ?? "none",
        error: error.message,
      })
      return {
        success: false,
        tentacleId: params.tentacleId,
        skillName: params.skillName,
        errors: [error.message],
      }
    }

    // 2. Single Claude Code generation only
    brainLogger.info("code_agent_attempt", {
      tentacle_id: params.tentacleId,
      attempt: 1,
      skill_name: params.skillName ?? "none",
    })

    let generated
    try {
      generated = await this.codeAgent.generate(requirement)
    } catch (error) {
      if (
        error instanceof CodeAgentTimeoutError
        || error instanceof CodeAgentProcessError
        || error instanceof CodeAgentAlreadyRunningError
      ) {
        brainLogger.error("code_agent_generation_failed", {
          tentacle_id: params.tentacleId,
          session_file: error.sessionFile,
          elapsed_ms: error instanceof CodeAgentTimeoutError ? error.elapsedMs : undefined,
          turn_count: error instanceof CodeAgentTimeoutError ? error.turnCount : undefined,
          exit_code: error instanceof CodeAgentProcessError ? error.exitCode : undefined,
        })
        return {
          success: false,
          tentacleId: params.tentacleId,
          skillName: params.skillName,
          errors: [error.message],
          codeAgentSessionFile: error.sessionFile,
        }
      }
      throw error
    }

    const lastSessionFile = generated.diagnostics?.sessionFile
    const lastWorkDir = generated.diagnostics?.workDir
    if (!generated.files.length) {
      return {
        success: false,
        tentacleId: params.tentacleId,
        skillName: params.skillName,
        errors: ["Code generation produced no output"],
        codeAgentSessionFile: lastSessionFile,
        codeAgentWorkDir: lastWorkDir,
      }
    }

    // 3. Deploy generated files to a stable tentacle directory, but do not auto-spawn.
    const trigger = this.inferTrigger(params)
    let directory: string | undefined
    let deployError: string | undefined
    try {
      directory = await this.deployer.deploy(params.tentacleId, generated, {
        purpose: params.purpose,
        trigger,
        dataSources: params.externalApis,
        skillName: params.skillName,
        workflow: params.workflow,
        capabilities: params.capabilities,
        reportStrategy: params.reportStrategy,
      })
    } catch (error: any) {
      systemLogger.error("spawn_deploy_failed", {
        tentacle_id: params.tentacleId,
        error: error.message,
      })
      deployError = `部署失败: ${error.message}`
    }

    systemLogger.info("tentacle_generated", {
      tentacle_id: params.tentacleId,
      runtime: generated.runtime,
      skill_name: params.skillName,
      directory,
      code_agent_session_file: lastSessionFile,
    })
    brainLogger.info("tentacle_generated", {
      tentacle_id: params.tentacleId,
      runtime: generated.runtime,
      directory,
      code_agent_session_file: lastSessionFile,
    })

    return {
      success: true,
      tentacleId: params.tentacleId,
      skillName: params.skillName,
      runtime: generated.runtime,
      directory,
      trigger,
      description: generated.description,
      files: generated.files.map((file) => file.path),
      generatedFiles: generated.files.map((file) => ({
        path: file.path,
        location: directory ? path.join(directory, file.path) : undefined,
      })),
      entryCommand: generated.entryCommand,
      setupCommands: generated.setupCommands,
      dependencies: generated.dependencies,
      deployed: Boolean(directory),
      spawned: false,
      errors: deployError ? [deployError] : undefined,
      claudeFinalText: generated.diagnostics?.finalText ?? generated.description,
      claudeSessionId: generated.diagnostics?.claudeSessionId,
      claudeModelId: generated.diagnostics?.modelId,
      claudeResultSubtype: generated.diagnostics?.resultSubtype,
      codeAgentSessionFile: lastSessionFile,
      codeAgentWorkDir: lastWorkDir,
    }
  }

  // ── Private ─────────────────────────────────────────────────

  private async buildRequirement(params: SpawnParams): Promise<CodeAgentRequirement> {
    let skillContext: CodeAgentRequirement["skillContext"]

    if (params.skillName) {
      skillContext = await this.loadSkillContext(params.skillName)
    }

    const userContext = await this.loadUserContext()

    return {
      tentacleId: params.tentacleId,
      purpose: params.purpose,
      workflow: params.workflow,
      capabilities: params.capabilities ?? [],
      reportStrategy: params.reportStrategy ?? "Report accumulated findings in batch when 3+ items ready",
      infrastructure: params.infrastructure,
      externalApis: params.externalApis,
      preferredRuntime: (params.preferredRuntime as CodeAgentRequirement["preferredRuntime"]) ?? "auto",
      skillContext,
      userContext,
    }
  }

  private async loadSkillContext(skillName: string): Promise<CodeAgentRequirement["skillContext"]> {
    await this.skillLoader.loadAll()
    const skill = this.skillLoader.get(skillName)
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`)
    }
    if (!skill.spawnable) {
      throw new Error(`Skill is not spawnable: ${skillName}`)
    }

    const validation = await SkillInspector.validate(skill)
    if (!validation.valid) {
      throw new Error(`Skill validation failed: ${validation.errors.join("; ")}`)
    }

    // Read SKILL.md
    const skillMdPath = path.join(skill.path, "SKILL.md")
    const skillMd = await fs.readFile(skillMdPath, "utf-8")

    // Read all code files in the skill directory
    const codeFiles = await this.readSkillCodeFiles(skill.path)

    // Read requirements.txt if present
    const reqPath = path.join(skill.path, "requirements.txt")
    const requirements = existsSync(reqPath) ? await fs.readFile(reqPath, "utf-8") : undefined

    return { skillMd, codeFiles, requirements }
  }

  private async readSkillCodeFiles(skillDir: string): Promise<{ path: string; content: string }[]> {
    const files: { path: string; content: string }[] = []
    const walk = async (dir: string, prefix: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (["venv", "node_modules", "__pycache__", ".git"].includes(entry.name)) continue
          await walk(path.join(dir, entry.name), relPath)
        } else if (/\.(py|ts|js|go|sh|md|txt|json|yaml|yml)$/.test(entry.name)) {
          const content = await fs.readFile(path.join(dir, entry.name), "utf-8")
          files.push({ path: relPath, content })
        }
      }
    }
    await walk(skillDir, "")
    return files
  }

  private async loadUserContext(): Promise<string> {
    try {
      const workspace = this.config.agents?.defaults?.workspace
      if (!workspace) return ""
      const userMdPath = path.join(workspace, "USER.md")
      if (!existsSync(userMdPath)) return ""
      const content = await fs.readFile(userMdPath, "utf-8")
      // Return truncated version
      return content.slice(0, 2000)
    } catch {
      return ""
    }
  }

  private inferTrigger(params: SpawnParams): string {
    if (params.skillName) {
      const skill = this.skillLoader.get(params.skillName)
      return skill?.tentacleConfig?.defaultTrigger ?? "30m"
    }
    return "6h"
  }

  private async applyDefaultSchedule(tentacleId: string, trigger: string): Promise<void> {
    const parsed = parseDefaultTrigger(trigger)
    if (parsed.kind === "self") {
      await this.tentacleManager.setTentacleSchedule(tentacleId, {
        primaryTrigger: { type: "self-schedule", interval: parsed.interval },
        cronJobs: [],
      })
      return
    }

    const cronScheduler = this.tentacleManager.getCronScheduler()
    if (!cronScheduler) {
      throw new Error("Cron scheduler unavailable for default cron trigger")
    }

    const jobId = `tc-${tentacleId}-default`
    await cronScheduler.addJob({
      jobId,
      name: `${tentacleId} default trigger`,
      schedule: { kind: "cron", expr: parsed.expr },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Trigger tentacle fetch cycle" },
      tentacleId,
    })
    await this.tentacleManager.setTentacleSchedule(tentacleId, {
      primaryTrigger: { type: "cron", jobId },
      cronJobs: [jobId],
    })
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function parseDefaultTrigger(trigger: string): { kind: "self"; interval: string } | { kind: "cron"; expr: string } {
  const trimmed = trigger.trim()
  if (/^(@yearly|@monthly|@weekly|@daily|@hourly|(\S+\s+){4,5}\S+)$/.test(trimmed)) {
    return { kind: "cron", expr: trimmed }
  }
  if (/^\d+(?:ms|s|m|h|d|w)$/.test(trimmed)) {
    parseDurationMs(trimmed)
    return { kind: "self", interval: trimmed }
  }

  const everyMatch = trimmed.match(/^every\s+(\d+)\s*(minute|minutes|hour|hours|day|days)$/i)
  if (everyMatch) {
    const value = everyMatch[1]
    const unitMap: Record<string, string> = {
      minute: "m", minutes: "m",
      hour: "h", hours: "h",
      day: "d", days: "d",
    }
    const interval = `${value}${unitMap[everyMatch[2].toLowerCase()]}`
    parseDurationMs(interval)
    return { kind: "self", interval }
  }

  return { kind: "self", interval: "6h" }
}
