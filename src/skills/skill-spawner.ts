import * as fs from "fs/promises"
import { existsSync } from "fs"
import { execFile } from "child_process"
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
import { SkillLoader, type SkillTentacleConfig } from "./skill-loader.js"
import { SkillInspector } from "./skill-inspector.js"
import { TentacleValidator } from "../code-agent/validator.js"
import { TentacleManager } from "../tentacle/manager.js"
import type { TentacleCapability } from "../tentacle/contract.js"
import { parseDurationMs } from "../cron/time.js"
import type { CredentialStore } from "../config/credential-store.js"
import { buildTentacleModelEnv } from "../config/model-runtime.js"
import { TentaclePackager } from "./tentacle-packager.js"

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

  // M4 additions
  skillTentaclePath?: string
  packageAfter?: boolean
  config?: Record<string, unknown>
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
  source?: string
  packagePath?: string
}

const ENV_TO_CREDENTIAL_MAP: Record<string, string[]> = {
  OPENROUTER_API_KEY: ["openrouter", "openrouter/api_key"],
  ANTHROPIC_API_KEY: ["anthropic", "anthropic/api_key"],
  GITHUB_TOKEN: ["github", "github/token"],
  FEISHU_APP_ID: ["feishu/app_id"],
  FEISHU_APP_SECRET: ["feishu/app_secret"],
  DISCORD_BOT_TOKEN: ["discord", "discord/token"],
}

export class SkillSpawner {
  private codeAgent: CodeAgent
  private deployer: TentacleDeployer

  constructor(
    private config: OpenCephConfig,
    private skillLoader: SkillLoader,
    private tentacleManager: TentacleManager,
    codeAgent: CodeAgent,
    private credentialStore?: CredentialStore,
  ) {
    this.codeAgent = codeAgent
    this.deployer = new TentacleDeployer(tentacleManager.getTentacleBaseDir())
  }

  private createPackager(): TentaclePackager {
    return new TentaclePackager(this.config.skillTentacle?.packExclude)
  }

  /**
   * Unified spawn entry point.
   * Routes to the appropriate spawn path based on skill type:
   * - skill_tentacle → spawnFromSkillTentacle (scene 1: deploy existing)
   * - legacy spawnable SKILL → spawnFromLegacySkill (Claude Code generates from blueprint)
   * - no skill → spawnFromScratch (scene 2: Claude Code generates skill_tentacle)
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

    // Route: direct path to skill_tentacle directory or .tentacle file
    if (params.skillTentaclePath) {
      return this.spawnFromPath(params)
    }

    // Route decision
    if (params.skillName) {
      const skill = this.skillLoader.get(params.skillName)
      if (skill?.isSkillTentacle) {
        brainLogger.info("skill_tentacle_matched", {
          skill_name: params.skillName,
          match_reason: "isSkillTentacle=true",
        })
        return this.spawnFromSkillTentacle(params, skill)
      }
      if (skill?.spawnable) {
        return this.spawnFromLegacySkill(params)
      }
    }

    // Scene 2: Generate from scratch as skill_tentacle
    brainLogger.info("tentacle_creator_start", {
      tentacle_id: params.tentacleId,
      purpose: params.purpose,
    })
    return this.spawnFromScratch(params)
  }

  // ── Direct path routing (skill_tentacle_path param) ──

  private async spawnFromPath(params: SpawnParams): Promise<SpawnResult> {
    const skillPath = params.skillTentaclePath!
    let resolvedDir: string

    try {
      const stat = await fs.stat(skillPath)
      if (stat.isDirectory()) {
        resolvedDir = skillPath
      } else if (skillPath.endsWith(".tentacle")) {
        const packager = this.createPackager()
        resolvedDir = await packager.install(skillPath)
      } else {
        return { success: false, errors: [`skill_tentacle_path 不是目录或 .tentacle 文件: ${skillPath}`] }
      }
    } catch (err: any) {
      return { success: false, errors: [`skill_tentacle_path 无法访问: ${err.message}`] }
    }

    const skill = await this.skillLoader.loadSingle(resolvedDir)
    if (!skill?.isSkillTentacle) {
      return { success: false, errors: [`${resolvedDir} 不是有效的 skill_tentacle 目录（需要 SKILL.md + prompt/SYSTEM.md + src/ + README.md）`] }
    }

    brainLogger.info("skill_tentacle_matched", {
      skill_name: skill.name,
      match_reason: "skillTentaclePath",
      path: resolvedDir,
    })
    return this.spawnFromSkillTentacle(params, skill)
  }

  // ── spawn + IPC register helper ──

  private async spawnAndRegister(
    tentacleId: string,
    timeoutMs = 30_000,
  ): Promise<{ success: boolean; error?: string; pid?: number }> {
    await this.tentacleManager.spawn(tentacleId)
    const registered = await this.tentacleManager.waitForRegistration(tentacleId, timeoutMs)
    if (!registered) {
      await this.tentacleManager.kill(tentacleId, "registration_timeout")
      return { success: false, error: `IPC registration timed out after ${timeoutMs}ms` }
    }
    const status = this.tentacleManager.getStatus(tentacleId)
    return { success: true, pid: status?.pid }
  }

  // ── Scene 1: Deploy community skill_tentacle (no code generation) ──

  private async spawnFromSkillTentacle(
    params: SpawnParams,
    skill: NonNullable<ReturnType<SkillLoader["get"]>>,
  ): Promise<SpawnResult> {
    const tentacleDir = path.join(this.tentacleManager.getTentacleBaseDir(), params.tentacleId)

    brainLogger.info("skill_tentacle_deploy_start", {
      tentacle_id: params.tentacleId,
      skill_name: skill.name,
    })

    // Step 1: Validate
    const validation = await SkillInspector.validateSkillTentacle(skill.path)
    if (!validation.valid) {
      brainLogger.error("skill_tentacle_deploy_failed", {
        tentacle_id: params.tentacleId,
        errors: validation.errors.map((e) => e.message),
      })
      return { success: false, errors: validation.errors.map((e) => e.message) }
    }

    const prerequisiteErrors = await this.validateSkillTentaclePrerequisites(skill.name, skill.skillTentacleConfig)
    if (prerequisiteErrors.length > 0) {
      brainLogger.error("skill_tentacle_deploy_failed", {
        tentacle_id: params.tentacleId,
        errors: prerequisiteErrors,
        phase: "prerequisites",
      })
      return { success: false, errors: prerequisiteErrors }
    }

    // Step 2: Copy to runtime directory
    await fs.cp(skill.path, tentacleDir, { recursive: true })

    // Step 3: Inject user config and collect placeholder mapping
    let placeholderMapping: Record<string, string> = {}
    if (skill.skillTentacleConfig) {
      try {
        placeholderMapping = await this.injectUserConfig(tentacleDir, params.config ?? {}, skill.skillTentacleConfig)
        brainLogger.info("user_config_injected", {
          tentacle_id: params.tentacleId,
          fields_count: Object.keys(params.config ?? {}).length,
        })
      } catch (err: any) {
        await fs.rm(tentacleDir, { recursive: true, force: true }).catch(() => {})
        brainLogger.error("skill_tentacle_deploy_failed", {
          tentacle_id: params.tentacleId,
          error: err.message,
          phase: "env_injection",
        })
        return { success: false, errors: [err.message] }
      }
    }

    // Step 4: Claude Code deploy (minimal prompt — read README.md and execute)
    try {
      await this.codeAgent.deployExisting(tentacleDir)
    } catch (err: any) {
      await fs.rm(tentacleDir, { recursive: true, force: true }).catch(() => {})
      brainLogger.error("skill_tentacle_deploy_failed", {
        tentacle_id: params.tentacleId,
        error: err.message,
      })
      return { success: false, errors: [`部署失败：${err.message}`] }
    }

    // Step 5: Write tentacle.json and prepare for spawn
    const trigger = skill.skillTentacleConfig?.defaultTrigger ?? "30m"
    await this.writeTentacleJson(params.tentacleId, tentacleDir, skill.skillTentacleConfig, {
      purpose: params.purpose,
      trigger,
      skillName: skill.name,
      source: `skill_tentacle:${skill.name}`,
      placeholderMapping,
    })

    brainLogger.info("skill_tentacle_deploy_success", {
      tentacle_id: params.tentacleId,
      skill_name: skill.name,
      runtime: skill.skillTentacleConfig?.runtime,
    })

    systemLogger.info("skill_tentacle_deployed", {
      tentacle_id: params.tentacleId,
      skill_name: skill.name,
    })

    // Step 6: Spawn process + wait for IPC registration
    const spawnResult = await this.spawnAndRegister(params.tentacleId)
    if (!spawnResult.success) {
      brainLogger.error("skill_tentacle_deploy_failed", {
        tentacle_id: params.tentacleId,
        error: spawnResult.error,
        phase: "ipc_registration",
      })
      return { success: false, errors: [spawnResult.error ?? "IPC registration failed"] }
    }

    brainLogger.info("tentacle_spawned", {
      tentacle_id: params.tentacleId,
      pid: spawnResult.pid,
    })

    return {
      success: true,
      tentacleId: params.tentacleId,
      skillName: skill.name,
      runtime: skill.skillTentacleConfig?.runtime,
      directory: tentacleDir,
      trigger,
      description: skill.description,
      deployed: true,
      spawned: true,
      pid: spawnResult.pid,
      source: `skill_tentacle:${skill.name}`,
    }
  }

  // ── Scene 2: Claude Code generates a full skill_tentacle ──

  private async spawnFromScratch(params: SpawnParams): Promise<SpawnResult> {
    const tentacleDir = path.join(this.tentacleManager.getTentacleBaseDir(), params.tentacleId)

    brainLogger.info("tentacle_creator_generate", {
      tentacle_id: params.tentacleId,
      purpose: params.purpose,
    })

    // Step 1: Claude Code generates complete skill_tentacle
    try {
      await this.codeAgent.generateSkillTentacle({
        tentacleId: params.tentacleId,
        purpose: params.purpose,
        workflow: params.workflow,
        capabilities: params.capabilities ?? [],
        reportStrategy: params.reportStrategy ?? "积攒有价值信息后批量上报大脑",
        infrastructure: params.infrastructure,
        externalApis: params.externalApis,
        preferredRuntime: (params.preferredRuntime as CodeAgentRequirement["preferredRuntime"]) ?? "auto",
        userContext: await this.loadUserContext(),
      })
    } catch (error: any) {
      brainLogger.error("tentacle_creator_generate_failed", {
        tentacle_id: params.tentacleId,
        error: error.message,
      })
      return {
        success: false,
        tentacleId: params.tentacleId,
        errors: [error.message],
      }
    }

    // Step 2: Validate the generated skill_tentacle via TentacleValidator (up to 3 retries)
    const smokeTestTimeoutMs = this.config.skillTentacle?.validation?.smokeTestTimeoutMs ?? 5000
    const validator = new TentacleValidator()
    validator.setSmokeTestTimeoutMs(smokeTestTimeoutMs)
    const maxRetries = this.config.tentacle.codeGenMaxRetries
    let lastErrors: string[] = []
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const validation = await validator.validateSkillTentacle(tentacleDir)
      const allErrors = Object.values(validation.checks).flatMap((c) => c.errors)
      brainLogger.info("tentacle_creator_validate", {
        tentacle_id: params.tentacleId,
        attempt,
        passed: validation.passed,
        errors: allErrors.map((e) => e.message),
        checks: Object.fromEntries(Object.entries(validation.checks).map(([k, v]) => [k, v.passed])),
      })

      if (validation.passed) {
        lastErrors = []
        break
      }

      lastErrors = allErrors.map((e) => e.message)
      if (attempt < maxRetries) {
        brainLogger.info("tentacle_creator_user_modify", {
          tentacle_id: params.tentacleId,
          attempt,
          errors: lastErrors,
        })
        try {
          await this.codeAgent.fixSkillTentacle(tentacleDir, allErrors)
        } catch {
          // fix attempt failed, continue to next retry
        }
      }
    }

    if (lastErrors.length > 0) {
      return {
        success: false,
        tentacleId: params.tentacleId,
        errors: lastErrors,
      }
    }

    // Step 3: Deploy (same as scene 1 Phase C-D)
    try {
      await this.codeAgent.deployExisting(tentacleDir)
    } catch (err: any) {
      return { success: false, errors: [`部署失败：${err.message}`] }
    }

    const trigger = this.inferTrigger(params)
    await this.writeTentacleJson(params.tentacleId, tentacleDir, undefined, {
      purpose: params.purpose,
      trigger,
      source: "generated",
    })

    // Step 4: Spawn process + wait for IPC registration
    const spawnResult = await this.spawnAndRegister(params.tentacleId)
    if (!spawnResult.success) {
      return { success: false, errors: [spawnResult.error ?? "IPC registration failed"] }
    }

    brainLogger.info("tentacle_spawned", {
      tentacle_id: params.tentacleId,
      pid: spawnResult.pid,
    })

    // Optional: Package for community sharing
    let packagePath: string | undefined
    if (params.packageAfter) {
      try {
        const packager = this.createPackager()
        packagePath = await packager.pack(params.tentacleId)
        brainLogger.info("skill_tentacle_packaged", {
          tentacle_id: params.tentacleId,
          output_path: packagePath,
        })
      } catch (err: any) {
        brainLogger.info("skill_tentacle_package_failed", { tentacle_id: params.tentacleId, error: err.message })
      }
    }

    return {
      success: true,
      tentacleId: params.tentacleId,
      runtime: params.preferredRuntime ?? "python",
      directory: tentacleDir,
      trigger,
      deployed: true,
      spawned: true,
      pid: spawnResult.pid,
      packagePath,
      source: "generated",
    }
  }

  // ── Legacy: Generate from SKILL blueprint (M3 compatible) ──

  private async spawnFromLegacySkill(params: SpawnParams): Promise<SpawnResult> {
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

    // 2. Single Claude Code generation
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

    // 3. Deploy generated files
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

  // ── User config injection (scene 1) ──

  private async injectUserConfig(
    tentacleDir: string,
    userConfig: Record<string, unknown>,
    tentacleConfig: SkillTentacleConfig,
  ): Promise<Record<string, string>> {
    const placeholderMapping: Record<string, string> = {}
    // 1. Generate .env file
    const envEntries = new Map<string, string>()
    const missingRequiredEnv: Array<{ envVar: string; tried: string[] }> = []
    const setEnv = (key: string, value: string | undefined) => {
      if (value !== undefined && value !== "") {
        envEntries.set(key, value)
      }
    }

    // OpenCeph auto-injected variables
    setEnv("OPENCEPH_IPC_SOCKET", this.config.tentacle.ipcSocketPath)
    setEnv("OPENCEPH_SOCKET_PATH", this.config.tentacle.ipcSocketPath)
    setEnv("OPENCEPH_TENTACLE_ID", path.basename(tentacleDir))
    setEnv("OPENCEPH_TRIGGER_MODE", "self")

    for (const [key, value] of Object.entries(buildTentacleModelEnv(this.config))) {
      setEnv(key, value)
    }

    // Read required env vars from credentials store
    for (const envVar of tentacleConfig.requires.env) {
      const candidates = this.getCredentialCandidates(envVar)
      const value = await this.resolveRequiredEnvValue(envVar, candidates)
      if (value) {
        setEnv(envVar, value)
      } else {
        missingRequiredEnv.push({ envVar, tried: [...candidates, `process.env.${envVar}`] })
      }
    }

    // Inject customizable env_var fields
    for (const custom of tentacleConfig.customizable ?? []) {
      if (custom.envVar) {
        const val = userConfig[custom.field] ?? custom.default
        if (val !== undefined) {
          setEnv(custom.envVar, String(val))
        }
      }
    }

    if (missingRequiredEnv.length > 0) {
      for (const missing of missingRequiredEnv) {
        brainLogger.warn("skill_tentacle_missing_env", {
          tentacle_id: path.basename(tentacleDir),
          env_var: missing.envVar,
          tried: missing.tried,
        })
      }
      const missingSummary = missingRequiredEnv
        .map((missing) => {
          const primaryCredential = this.getPrimaryCredentialCandidate(missing.envVar)
          return `${missing.envVar}（请设置 ${missing.envVar} 或写入 credentials/${primaryCredential}）`
        })
        .join("，")
      throw new Error(`skill_tentacle 缺少必需环境变量：${missingSummary}`)
    }

    const envLines = Array.from(envEntries.entries()).map(([key, value]) => `${key}=${value}`)
    await fs.writeFile(path.join(tentacleDir, ".env"), envLines.join("\n") + "\n")

    // 2. Replace placeholders in prompt/SYSTEM.md
    const systemPromptPath = path.join(tentacleDir, "prompt", "SYSTEM.md")
    if (existsSync(systemPromptPath)) {
      let content = await fs.readFile(systemPromptPath, "utf-8")

      // Standard placeholders from USER.md
      const userMd = await this.loadUserContext()
      const userName = extractUserName(userMd)
      const techFocus = extractTechFocus(userMd)
      const notInterested = extractNotInterested(userMd)

      if (content.includes("{USER_NAME}")) placeholderMapping["{USER_NAME}"] = userName
      if (content.includes("{USER_TECHNICAL_FOCUS}")) placeholderMapping["{USER_TECHNICAL_FOCUS}"] = techFocus
      if (content.includes("{USER_NOT_INTERESTED}")) placeholderMapping["{USER_NOT_INTERESTED}"] = notInterested

      content = content
        .replace(/\{USER_NAME\}/g, userName)
        .replace(/\{USER_TECHNICAL_FOCUS\}/g, techFocus)
        .replace(/\{USER_NOT_INTERESTED\}/g, notInterested)

      // Customizable prompt_placeholder fields
      for (const custom of tentacleConfig.customizable ?? []) {
        if (custom.promptPlaceholder) {
          const val = userConfig[custom.field] ?? custom.default ?? ""
          placeholderMapping[custom.promptPlaceholder] = String(val)
          content = content.replace(
            new RegExp(escapeRegex(custom.promptPlaceholder), "g"),
            String(val),
          )
        }
      }

      await fs.writeFile(systemPromptPath, content)
    }

    return placeholderMapping
  }

  // ── Write tentacle.json metadata ──

  private async writeTentacleJson(
    tentacleId: string,
    tentacleDir: string,
    config?: SkillTentacleConfig,
    metadata?: {
      purpose?: string
      trigger?: string
      skillName?: string
      source?: string
      placeholderMapping?: Record<string, string>
    },
  ): Promise<void> {
    const entryCommand = await this.detectEntryCommand(tentacleDir, config)

    await fs.writeFile(path.join(tentacleDir, "tentacle.json"), JSON.stringify({
      tentacleId,
      purpose: metadata?.purpose ?? "skill_tentacle",
      runtime: config?.runtime ?? "python",
      entryCommand,
      cwd: tentacleDir,
      source: metadata?.source ?? "skill_tentacle",
      trigger: metadata?.trigger ?? "manual",
      createdAt: new Date().toISOString(),
      scheduleConfig: {
        primaryTrigger: { type: "self-schedule", interval: metadata?.trigger ?? "6h" },
        cronJobs: [],
      },
      skillName: metadata?.skillName,
      placeholderMapping: metadata?.placeholderMapping ?? {},
    }, null, 2), "utf-8")
  }

  private async detectEntryCommand(
    tentacleDir: string,
    config?: SkillTentacleConfig,
  ): Promise<string> {
    const readmeCommand = await this.extractReadmeStartCommand(tentacleDir)
    if (readmeCommand) {
      return readmeCommand
    }

    const entry = config?.entry
    if (entry) {
      const hasVenvPython = existsSync(path.join(tentacleDir, "venv", "bin", "python"))
      if (config.runtime === "python") {
        return hasVenvPython ? `venv/bin/python ${entry}` : `python3 ${entry}`
      }
      if (config.runtime === "typescript") return `npx tsx ${entry}`
      if (config.runtime === "go") return `go run ${entry}`
      if (config.runtime === "shell") return `bash ${entry}`
    }

    if (existsSync(path.join(tentacleDir, "src", "main.py"))) {
      const hasVenvPython = existsSync(path.join(tentacleDir, "venv", "bin", "python"))
      return hasVenvPython ? "venv/bin/python src/main.py" : "python3 src/main.py"
    }
    if (existsSync(path.join(tentacleDir, "src", "index.ts"))) {
      return "npx tsx src/index.ts"
    }
    if (existsSync(path.join(tentacleDir, "src", "main.go"))) {
      return "go run src/main.go"
    }
    if (existsSync(path.join(tentacleDir, "src", "main.sh"))) {
      return "bash src/main.sh"
    }
    return "python3 src/main.py"
  }

  // ── Private helpers ──

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

    const skillMdPath = path.join(skill.path, "SKILL.md")
    const skillMd = await fs.readFile(skillMdPath, "utf-8")
    const codeFiles = await this.readSkillCodeFiles(skill.path)
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

  private async validateSkillTentaclePrerequisites(
    skillName: string,
    tentacleConfig?: SkillTentacleConfig,
  ): Promise<string[]> {
    if (!tentacleConfig) return []

    const errors: string[] = []

    for (const bin of tentacleConfig.requires.bins) {
      if (!(await hasCommand(bin))) {
        errors.push(`skill_tentacle ${skillName} 缺少必需命令：${bin}`)
      }
    }

    for (const envVar of tentacleConfig.requires.env) {
      const value = await this.resolveRequiredEnvValue(envVar)
      if (!value) {
        const primaryCredential = this.getPrimaryCredentialCandidate(envVar)
        errors.push(`skill_tentacle ${skillName} 缺少必需环境变量：${envVar}（请设置 ${envVar} 或写入 credentials/${primaryCredential}）`)
      }
    }

    return errors
  }

  private async resolveRequiredEnvValue(envVar: string, candidates = this.getCredentialCandidates(envVar)): Promise<string | undefined> {
    if (process.env[envVar]) {
      return process.env[envVar]
    }

    const modelEnv = buildTentacleModelEnv(this.config)
    if (modelEnv[envVar]) {
      return modelEnv[envVar]
    }

    if (!this.credentialStore) {
      return undefined
    }

    for (const candidate of candidates) {
      try {
        const value = await this.credentialStore.get(candidate)
        if (value) {
          return value
        }
      } catch {
        // try next candidate
      }
    }
    return undefined
  }

  private getCredentialCandidates(envVar: string): string[] {
    const lower = envVar.toLowerCase()
    const candidates = new Set<string>(ENV_TO_CREDENTIAL_MAP[envVar] ?? [])
    const apiKeyMatch = lower.match(/^([a-z0-9]+)_api_key$/)
    const tokenMatch = lower.match(/^([a-z0-9]+)_token$/)
    const appIdMatch = lower.match(/^([a-z0-9]+)_app_id$/)
    const appSecretMatch = lower.match(/^([a-z0-9]+)_app_secret$/)

    candidates.add(lower)
    candidates.add(lower.replace(/_/g, "/"))

    if (apiKeyMatch) {
      candidates.add(apiKeyMatch[1])
      candidates.add(`${apiKeyMatch[1]}/api_key`)
    }
    if (tokenMatch) {
      candidates.add(tokenMatch[1])
      candidates.add(`${tokenMatch[1]}/token`)
    }
    if (appIdMatch) {
      candidates.add(appIdMatch[1])
      candidates.add(`${appIdMatch[1]}/app_id`)
    }
    if (appSecretMatch) {
      candidates.add(appSecretMatch[1])
      candidates.add(`${appSecretMatch[1]}/app_secret`)
    }

    return [...candidates]
  }

  private getPrimaryCredentialCandidate(envVar: string): string {
    return this.getCredentialCandidates(envVar)[0] ?? envVar.toLowerCase()
  }

  private async extractReadmeStartCommand(tentacleDir: string): Promise<string | undefined> {
    const readmePath = path.join(tentacleDir, "README.md")
    if (!existsSync(readmePath)) return undefined

    let readme: string
    try {
      readme = await fs.readFile(readmePath, "utf-8")
    } catch {
      return undefined
    }

    const sections = [/^##\s+Start Command\s*$/im, /^##\s+Running\s*$/im, /^##\s+Start\s*$/im]
    for (const sectionPattern of sections) {
      const match = sectionPattern.exec(readme)
      if (!match || match.index === undefined) continue
      const section = readme.slice(match.index + match[0].length)
      const codeBlockMatch = section.match(/```(?:bash|sh)?\n([\s\S]*?)```/)
      const command = this.extractCommandFromContent(codeBlockMatch?.[1])
      if (command) return command
    }

    return this.extractCommandFromContent(readme)
  }

  private extractCommandFromContent(content?: string): string | undefined {
    if (!content) return undefined
    return content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => {
        if (!line || line.startsWith("#")) return false
        if (line.includes("--dry-run")) return false
        return /^(python3|python|venv\/bin\/python|npx\s+tsx|node|go\s+run|bash)\s+/.test(line)
      })
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

function extractUserName(userMd: string): string {
  const match = userMd.match(/name[:\s]+(.+)/i)
  return match?.[1]?.trim() ?? "User"
}

function extractTechFocus(userMd: string): string {
  const match = userMd.match(/(?:tech|technical|focus|interest)[:\s]+(.+)/i)
  return match?.[1]?.trim() ?? ""
}

function extractNotInterested(userMd: string): string {
  const match = userMd.match(/not.?interested[:\s]+(.+)/i)
  return match?.[1]?.trim() ?? ""
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hasCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("bash", ["-lc", `command -v ${JSON.stringify(command)}`], (error) => resolve(!error))
  })
}
