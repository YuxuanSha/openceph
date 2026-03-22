import * as fs from "fs/promises"
import { createWriteStream, existsSync } from "fs"
import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "child_process"
import * as os from "os"
import * as path from "path"
import { fileURLToPath } from "url"
import type { OpenCephConfig } from "../config/config-schema.js"
import { brainLogger, codeAgentLogger } from "../logger/index.js"
import type { PiContext } from "../pi/pi-context.js"
import { detectRuntimes } from "../tentacle/runtime-detector.js"
import type { TentacleCapability } from "../tentacle/contract.js"
import type { CodeAgentSessionArtifact } from "./types.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface CodeAgentRequirement {
  tentacleId: string
  purpose: string
  workflow: string
  capabilities: TentacleCapability[]
  reportStrategy: string
  infrastructure?: {
    needsHttpServer?: boolean
    needsDatabase?: boolean
    needsExternalBot?: {
      platform: "feishu" | "telegram" | "discord"
      purpose: string
    }
    needsLlm?: boolean
    needsFileStorage?: boolean
  }
  externalApis?: string[]
  preferredRuntime: "python" | "typescript" | "go" | "shell" | "auto"
  skillContext?: {
    skillMd: string
    codeFiles: { path: string; content: string }[]
    requirements?: string
  }
  userContext: string
}

export interface GeneratedCode {
  runtime: string
  files: { path: string; content: string }[]
  entryCommand: string
  setupCommands: string[]
  dependencies?: string
  envVars?: string[]
  ports?: number[]
  description: string
  diagnostics?: CodeAgentSessionArtifact
}

export interface ValidationError {
  check: "syntax" | "contract" | "security" | "smoke"
  message: string
  file?: string
  line?: number
  suggestion?: string
}

export interface PatchRequirement {
  tentacleId: string
  description: string
  additionalCapabilities?: TentacleCapability[]
  newFrequency?: string
}

export interface CodePatch {
  files: { path: string; content: string; action: "create" | "replace" | "delete" }[]
  description: string
}

export interface MergeTentacleInfo {
  tentacleId: string
  purpose: string
  runtime: string
  codeFiles: { path: string; content: string }[]
}

export interface MergeRequirement {
  newTentacleId: string
  newPurpose: string
  preferredRuntime?: string
}

interface RunWithPollingOptions {
  tentacleId: string
  sessionFile: string
  prompt: string
  workDir: string
  pollIntervalMs: number
  idleTimeoutMs: number
}

interface RunWithPollingResult extends CodeAgentSessionArtifact {}

interface CodeAgentDependencies {
  spawn?: typeof defaultSpawn
  now?: () => number
}

export class CodeAgentTimeoutError extends Error {
  readonly turnCount: number
  readonly elapsedMs: number
  readonly sessionFile: string

  constructor(message: string, input: { turnCount: number; elapsedMs: number; sessionFile: string }) {
    super(message)
    this.name = "CodeAgentTimeoutError"
    this.turnCount = input.turnCount
    this.elapsedMs = input.elapsedMs
    this.sessionFile = input.sessionFile
  }
}

export class CodeAgentProcessError extends Error {
  readonly exitCode: number | null
  readonly sessionFile: string

  constructor(message: string, input: { exitCode: number | null; sessionFile: string }) {
    super(message)
    this.name = "CodeAgentProcessError"
    this.exitCode = input.exitCode
    this.sessionFile = input.sessionFile
  }
}

export class CodeAgentAlreadyRunningError extends Error {
  readonly tentacleId: string
  readonly sessionFile: string

  constructor(message: string, input: { tentacleId: string; sessionFile: string }) {
    super(message)
    this.name = "CodeAgentAlreadyRunningError"
    this.tentacleId = input.tentacleId
    this.sessionFile = input.sessionFile
  }
}

export class CodeAgent {
  private static readonly activeRuns = new Map<string, { sessionFile: string; startedAt: number }>()

  constructor(
    private readonly piCtx: PiContext,
    private readonly config: OpenCephConfig,
    private readonly deps: CodeAgentDependencies = {},
  ) {}

  async generate(requirement: CodeAgentRequirement): Promise<GeneratedCode> {
    const runtime = await this.chooseRuntime(requirement.preferredRuntime)
    const prompt = await this.assemblePrompt({
      mode: "generate",
      runtime,
      requirement,
    })
    return this.runGeneratedCode(prompt, requirement, runtime, "generate")
  }

  async fix(
    previousCode: GeneratedCode,
    errors: ValidationError[],
    requirement: CodeAgentRequirement,
  ): Promise<GeneratedCode> {
    const runtime = previousCode.runtime
    const prompt = await this.assemblePrompt({
      mode: "fix",
      runtime,
      requirement,
      previousCode,
      errors,
    })
    return this.runGeneratedCode(prompt, requirement, runtime, "fix")
  }

  async generatePatch(existingCode: string, patchRequirement: PatchRequirement): Promise<CodePatch> {
    if (shouldUseEmergencyFallback()) {
      return buildEmergencyPatch(existingCode, patchRequirement)
    }
    const files = parseAggregatedFiles(existingCode)
    const description = patchRequirement.description
    return {
      files: buildPatchFiles(files.length > 0 ? files : [], patchRequirement),
      description,
    }
  }

  async generateMerged(
    tentacles: MergeTentacleInfo[],
    mergeRequirement: MergeRequirement,
  ): Promise<GeneratedCode> {
    const runtime = mergeRequirement.preferredRuntime ?? tentacles[0]?.runtime ?? "python"
    const mergeSpec = await readPrompt("merge-spec.md").catch(() => "")
    const prompt = [
      "You are merging multiple OpenCeph tentacles into a single new tentacle project.",
      mergeSpec,
      "",
      `New tentacle id: ${mergeRequirement.newTentacleId}`,
      `New purpose: ${mergeRequirement.newPurpose}`,
      `Preferred runtime: ${runtime}`,
      "",
      ...tentacles.map((tentacle) => [
        `## ${tentacle.tentacleId}`,
        `purpose: ${tentacle.purpose}`,
        `runtime: ${tentacle.runtime}`,
        ...tentacle.codeFiles.map((file) => `--- ${file.path} ---\n${file.content}`),
      ].join("\n")),
      "",
      "Rewrite the project in the current working directory using tools only.",
      "You must preserve the OpenCeph IPC contract and generate a coherent merged tentacle.",
    ].join("\n")

    return this.runGeneratedCode(prompt, {
      tentacleId: mergeRequirement.newTentacleId,
      purpose: mergeRequirement.newPurpose,
      workflow: "Merged workflow from source tentacles",
      capabilities: [],
      reportStrategy: "Report merged findings using consultation sessions",
      preferredRuntime: runtime as CodeAgentRequirement["preferredRuntime"],
      userContext: "",
    }, runtime, "merge")
  }

  private async runGeneratedCode(
    prompt: string,
    requirement: CodeAgentRequirement,
    runtime: string,
    mode: "generate" | "fix" | "merge",
  ): Promise<GeneratedCode> {
    if (shouldUseEmergencyFallback()) {
      return buildEmergencyFallback(requirement, runtime)
    }

    const workDir = await this.prepareWorkDir(requirement.tentacleId, mode)
    const sessionFile = await this.prepareSessionFile(requirement.tentacleId, mode)
    const promptFile = path.join(workDir, ".openceph-prompt.md")
    await fs.writeFile(promptFile, prompt, "utf-8")
    this.acquireRun(requirement.tentacleId, sessionFile)

    try {
      codeAgentLogger.info("code_agent_session_create", {
        tentacle_id: requirement.tentacleId,
        mode,
        runtime,
        work_dir: workDir,
        session_file: sessionFile,
        runner: "claude-code-cli",
      })
      brainLogger.info("code_agent_session_create", {
        tentacle_id: requirement.tentacleId,
        mode,
        runtime,
        session_file: sessionFile,
        work_dir: workDir,
        runner: "claude-code-cli",
      })

      const run = await this.runWithPolling({
        tentacleId: requirement.tentacleId,
        sessionFile,
        prompt,
        workDir,
        pollIntervalMs: this.config.tentacle.codeGenPollIntervalMs,
        idleTimeoutMs: this.config.tentacle.codeGenIdleTimeoutMs ?? 60_000,
      })
      const generated = await this.collectGeneratedFiles(workDir, requirement, runtime, run)
      codeAgentLogger.info("code_agent_session_success", {
        tentacle_id: requirement.tentacleId,
        mode,
        runtime: generated.runtime,
        elapsed_ms: run.elapsedMs,
        turn_count: run.turnCount,
        file_count: generated.files.length,
        session_file: sessionFile,
        work_dir: workDir,
      })
      return generated
    } catch (error: any) {
      codeAgentLogger.error("code_agent_session_failed", {
        tentacle_id: requirement.tentacleId,
        mode,
        runtime,
        session_file: sessionFile,
        work_dir: workDir,
        error: error?.message ?? String(error),
        stack: error?.stack,
      })
      throw error
    } finally {
      await fs.unlink(promptFile).catch(() => undefined)
      this.releaseRun(requirement.tentacleId, sessionFile)
    }
  }

  private async runWithPolling(options: RunWithPollingOptions): Promise<RunWithPollingResult> {
    const { tentacleId, sessionFile, prompt, workDir, pollIntervalMs, idleTimeoutMs } = options
    const startTime = this.now()
    let lastActivityAt = this.now()
    let turnCount = 0
    let finalText = ""
    let lastToolName: string | undefined
    const toolCalls = new Map<string, RunWithPollingResult["toolCalls"][number]>()
    let resultPayload: any = null
    let stderr = ""
    let stdoutBuffer = ""
    let lineBuffer = ""
    let claudeSessionId: string | undefined
    let modelId: string | undefined
    let resultSubtype: string | undefined
    let settled = false
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let idleKillTimer: ReturnType<typeof setTimeout> | null = null

    const writer = createJsonlWriter(sessionFile)
    const appendEvent = (event: Record<string, unknown>) => writer.write(event)
    appendEvent({
      type: "session",
      version: 4,
      provider: "claude-code-cli",
      runner: "claude-code-cli",
      tentacle_id: tentacleId,
      timestamp: new Date(startTime).toISOString(),
      cwd: workDir,
      persistent_session: true,
    })

    return await new Promise<RunWithPollingResult>((resolve, reject) => {
      const proc = this.spawnProc("claude", this.buildClaudeArgs(workDir), {
        cwd: workDir,
        env: {
          ...process.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      })

      const finish = async (fn: () => void) => {
        if (settled) return
        settled = true
        if (idleKillTimer) {
          clearTimeout(idleKillTimer)
          idleKillTimer = null
        }
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        await writer.close()
        fn()
      }

      const fail = async (error: Error) => {
        appendEvent({
          type: "error",
          timestamp: new Date(this.now()).toISOString(),
          error: error.message,
        })
        await finish(() => reject(error))
      }

      const handleToolUse = (toolUse: { id?: string; name?: string; input?: unknown }) => {
        if (!toolUse.id || !toolUse.name) return
        if (!toolCalls.has(toolUse.id)) {
          turnCount += 1
          lastToolName = toolUse.name
          const item = {
            toolName: toolUse.name,
            toolCallId: toolUse.id,
            startedAt: new Date(this.now()).toISOString(),
          }
          toolCalls.set(toolUse.id, item)
          appendEvent({
            type: "tool_call",
            timestamp: item.startedAt,
            tool_name: toolUse.name,
            tool_call_id: toolUse.id,
            input: toolUse.input,
          })
          codeAgentLogger.info("code_agent_tool_call", {
            tentacle_id: tentacleId,
            session_file: sessionFile,
            work_dir: workDir,
            turn: turnCount,
            tool: toolUse.name,
            tool_call_id: toolUse.id,
            args: summarizeValue(toolUse.input),
          })
        }
      }

      const handleToolResult = (toolResult: { tool_use_id?: string; is_error?: boolean; content?: unknown }) => {
        if (!toolResult.tool_use_id) return
        const item = toolCalls.get(toolResult.tool_use_id)
        if (!item) return
        item.endedAt = new Date(this.now()).toISOString()
        item.success = !toolResult.is_error
        appendEvent({
          type: "tool_result",
          timestamp: item.endedAt,
          tool_name: item.toolName,
          tool_call_id: item.toolCallId,
          success: item.success,
          content: toolResult.content,
        })
        codeAgentLogger.info("code_agent_tool_result", {
          tentacle_id: tentacleId,
          session_file: sessionFile,
          turn: turnCount,
          tool: item.toolName,
          tool_call_id: item.toolCallId,
          success: item.success,
          result: summarizeValue(toolResult.content),
        })
      }

      const handleJsonLine = (line: string) => {
        const parsed = safeJsonParse(line)
        if (!parsed || typeof parsed !== "object") return

        appendEvent({
          type: "stdout_json",
          timestamp: new Date(this.now()).toISOString(),
          payload: parsed,
        })

        const record = parsed as Record<string, any>
        if (record.type === "system" && record.subtype === "init") {
          claudeSessionId = typeof record.session_id === "string" ? record.session_id : undefined
          modelId = typeof record.model === "string" ? record.model : undefined
          appendEvent({
            type: "model_change",
            timestamp: new Date(this.now()).toISOString(),
            provider: "claude-code-cli",
            modelId,
            session_id: claudeSessionId,
          })
          return
        }

        if (record.type === "assistant" && record.message?.role === "assistant") {
          const contentBlocks: Array<Record<string, any>> = Array.isArray(record.message.content) ? record.message.content : []
          const text = contentBlocks
            .filter((block: Record<string, any>) => block?.type === "text" && typeof block.text === "string")
            .map((block: Record<string, any>) => block.text as string)
            .join("")
            .trim()
          if (text) {
            finalText = text
          }
          for (const block of contentBlocks) {
            if (block?.type === "tool_use") {
              handleToolUse(block)
            }
          }
          return
        }

        if (record.type === "user" && Array.isArray(record.message?.content)) {
          for (const block of record.message.content) {
            if (block?.type === "tool_result") {
              handleToolResult(block)
            }
          }
          return
        }

        if (record.type === "result") {
          resultPayload = record
          resultSubtype = typeof record.subtype === "string" ? record.subtype : undefined
          if (typeof record.result === "string" && record.result.trim()) {
            finalText = record.result.trim()
          }
        }
      }

      proc.stdout.on("data", (chunk: Buffer) => {
        lastActivityAt = this.now()
        const text = chunk.toString("utf-8")
        stdoutBuffer += text
        appendEvent({
          type: "stdout",
          timestamp: new Date(lastActivityAt).toISOString(),
          text,
        })

        lineBuffer += text
        const lines = lineBuffer.split("\n")
        lineBuffer = lines.pop() ?? ""
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          handleJsonLine(trimmed)
        }
      })

      proc.stderr.on("data", (chunk: Buffer) => {
        lastActivityAt = this.now()
        const text = chunk.toString("utf-8")
        stderr += text
        appendEvent({
          type: "stderr",
          timestamp: new Date(lastActivityAt).toISOString(),
          text,
        })
      })

      proc.on("error", async (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          await fail(new Error("Claude Code CLI 未安装。请运行 'npm install -g @anthropic-ai/claude-code' 并执行 'claude login'。"))
          return
        }
        await fail(error)
      })

      proc.on("close", async (code) => {
        if (lineBuffer.trim()) {
          handleJsonLine(lineBuffer.trim())
          lineBuffer = ""
        }

        appendEvent({
          type: "close",
          timestamp: new Date(this.now()).toISOString(),
          exit_code: code,
          result_subtype: resultPayload?.subtype,
        })

        if (settled) return
        if (code !== 0) {
          await fail(new CodeAgentProcessError(
            `Claude Code 退出码 ${code}: ${(stderr || stdoutBuffer).trim().slice(-500) || "unknown error"}`,
            { exitCode: code, sessionFile },
          ))
          return
        }

        await finish(() => resolve({
          sessionFile,
          workDir,
          elapsedMs: this.now() - startTime,
          turnCount,
          toolCalls: Array.from(toolCalls.values()),
          finalText: finalText.trim() || undefined,
          claudeSessionId,
          modelId,
          resultSubtype,
          persistentSession: true,
        }))
      })

      proc.stdin.write(prompt)
      proc.stdin.end()

      pollTimer = setInterval(() => {
        if (settled) return
        const now = this.now()
        const elapsed = now - startTime
        const idleMs = now - lastActivityAt

        appendEvent({
          type: "poll",
          timestamp: new Date(now).toISOString(),
          elapsed_ms: elapsed,
          idle_ms: idleMs,
          turn_count: turnCount,
          last_tool: lastToolName,
          is_active: idleMs < pollIntervalMs,
        })

        if (idleMs > idleTimeoutMs) {
          codeAgentLogger.error("code_agent_idle_timeout", {
            tentacle_id: tentacleId,
            session_file: sessionFile,
            work_dir: workDir,
            elapsed_ms: elapsed,
            idle_ms: idleMs,
            turn_count: turnCount,
            last_tool: lastToolName,
          })
          appendEvent({
            type: "timeout",
            timestamp: new Date(now).toISOString(),
            reason: "idle",
            elapsed_ms: elapsed,
            idle_ms: idleMs,
          })
          proc.kill("SIGTERM")
          idleKillTimer = setTimeout(() => {
            if (!settled) {
              proc.kill("SIGKILL")
            }
          }, 2_000)
          void fail(new CodeAgentTimeoutError(
            `Claude Code 连续 ${Math.round(idleMs / 1000)}s 无进展，已终止。总耗时 ${Math.round(elapsed / 1000)}s`,
            { turnCount, elapsedMs: elapsed, sessionFile },
          ))
          return
        }

        if (idleMs > pollIntervalMs * 2) {
          codeAgentLogger.warn("code_agent_idle", {
            tentacle_id: tentacleId,
            session_file: sessionFile,
            work_dir: workDir,
            idle_ms: idleMs,
            turn_count: turnCount,
            last_tool: lastToolName,
          })
        }

        codeAgentLogger.info("code_agent_poll", {
          tentacle_id: tentacleId,
          session_file: sessionFile,
          work_dir: workDir,
          elapsed_ms: elapsed,
          idle_ms: idleMs,
          turn_count: turnCount,
          is_active: idleMs < pollIntervalMs,
          last_tool: lastToolName,
        })
      }, pollIntervalMs)
    })
  }

  private async collectGeneratedFiles(
    workDir: string,
    requirement: CodeAgentRequirement,
    runtime: string,
    run: RunWithPollingResult,
  ): Promise<GeneratedCode> {
    const files = await readGeneratedFiles(workDir)
    if (files.length === 0) {
      throw new Error(`Claude Code completed but produced no files in ${workDir}`)
    }

    const entryCommand = inferEntryCommand(runtime, files)
    const setupCommands = inferSetupCommands(runtime, files)
    const dependencies = inferDependencies(runtime, files)
    const envVars = inferEnvVars(requirement)
    const description = run.finalText || `Generated tentacle for ${requirement.purpose}`

    return normalizeGeneratedCode({
      runtime,
      files,
      entryCommand,
      setupCommands,
      dependencies,
      description,
      envVars,
      diagnostics: run,
    }, runtime)
  }

  private async assemblePrompt(input: {
    mode: "generate" | "fix"
    runtime: string
    requirement: CodeAgentRequirement
    previousCode?: GeneratedCode
    errors?: ValidationError[]
  }): Promise<string> {
    const { mode, runtime, requirement, previousCode, errors } = input
    const contractSpec = await readPrompt("contract-spec.md")
    const langTemplate = await readPrompt(runtimePromptFile(runtime))
    const runtimeInfo = await detectRuntimes()

    const sections = [
      [
        "Section 1: Role Definition",
        "You are generating a complete tentacle Agent system for OpenCeph.",
        "A tentacle is an independent, long-running Agent program with its own process.",
        "Claude Code must work through tool calls only: read, write, edit, bash, grep, find, ls.",
      ].join("\n"),
      [
        "Section 2: IPC Contract (must implement)",
        contractSpec,
      ].join("\n"),
      [
        "Section 3: Requirement",
        `Purpose: ${requirement.purpose}`,
        "",
        "Workflow:",
        requirement.workflow,
        "",
        `Report Strategy: ${requirement.reportStrategy}`,
        `Capabilities: ${requirement.capabilities.join(", ") || "(none specified)"}`,
        `User Context: ${requirement.userContext || "(empty)"}`,
      ].join("\n"),
      [
        "Section 4: Runtime Environment",
        JSON.stringify(runtimeInfo, null, 2),
      ].join("\n"),
      [
        "Section 5: Runtime Template",
        langTemplate,
      ].join("\n"),
    ]

    if (requirement.infrastructure) {
      sections.push([
        "Section 6: Infrastructure",
        requirement.infrastructure.needsLlm ? "- Needs LLM calls (use OPENROUTER_API_KEY from env)" : "",
        requirement.infrastructure.needsDatabase ? "- Needs local SQLite or file database" : "",
        requirement.infrastructure.needsHttpServer ? "- Needs an HTTP server or webhook listener" : "",
        requirement.infrastructure.needsFileStorage ? "- Needs file-based state persistence" : "",
        requirement.infrastructure.needsExternalBot
          ? `- Needs independent ${requirement.infrastructure.needsExternalBot.platform} bot: ${requirement.infrastructure.needsExternalBot.purpose}`
          : "",
      ].filter(Boolean).join("\n"),
      )
    }

    if (requirement.externalApis?.length) {
      sections.push([
        "Section 7: External APIs",
        requirement.externalApis.join(", "),
      ].join("\n"))
    }

    if (requirement.skillContext) {
      sections.push([
        "Section 8: SKILL Blueprint",
        "Use the following blueprint as reference, but adapt it to the requirement above.",
        "",
        "SKILL.md:",
        requirement.skillContext.skillMd,
        "",
        "Reference files:",
        requirement.skillContext.codeFiles
          .map((file) => `### ${file.path}\n${file.content}`)
          .join("\n\n"),
      ].join("\n"))
    }

    if (mode === "fix" && previousCode && errors) {
      sections.push([
        "Section 9: Fix Previous Attempt",
        "The previous generation failed validation. Rewrite the affected files in the working directory.",
        "",
        "Validation errors:",
        errors.map((error) =>
          `- [${error.check}] ${error.message}${error.file ? ` (${error.file}${error.line ? `:${error.line}` : ""})` : ""}${error.suggestion ? `\n  Suggestion: ${error.suggestion}` : ""}`
        ).join("\n"),
        "",
        "Current generated files:",
        previousCode.files.map((file) => `### ${file.path}\n${file.content}`).join("\n\n"),
      ].join("\n"))
    }

    sections.push([
      "Section 10: Instructions",
      "1. Generate all code directly in the current working directory using tool calls.",
      "2. Use write or edit tools to create and update files. Do not return a JSON blob of the project.",
      "3. MUST implement the IPC contract: tentacle_register on startup, consultation_request as primary reporting path, directive handling, OPENCEPH_TRIGGER_MODE support.",
      "4. MUST read OPENCEPH_SOCKET_PATH or OPENCEPH_IPC_SOCKET and OPENCEPH_TENTACLE_ID from environment.",
      "5. MUST support external trigger mode. Self-schedule support is required when OPENCEPH_TRIGGER_MODE=self.",
      "6. Create requirements.txt / package.json / go.mod only if needed.",
      "7. After writing files, verify syntax with bash or language tools. Do not run npm install or pip install; the deployer handles setup.",
      "8. End with a concise summary of what files were generated and how the tentacle works.",
    ].join("\n"))

    return sections.join("\n\n")
  }

  private async chooseRuntime(preferred: CodeAgentRequirement["preferredRuntime"]): Promise<string> {
    const availability = await detectRuntimes()
    if (preferred !== "auto") return preferred
    if (availability.python3) return "python"
    if (availability.node) return "typescript"
    if (availability.go) return "go"
    return "shell"
  }

  private buildClaudeArgs(workDir: string): string[] {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--setting-sources", "local",
      "--add-dir", workDir,
      "--tools", "default",
    ]

    const model = this.resolveClaudeCliModel()
    if (model) {
      args.push("--model", model)
    }

    if (process.env.OPENCEPH_CLAUDE_CODE_MAX_BUDGET_USD) {
      args.push("--max-budget-usd", process.env.OPENCEPH_CLAUDE_CODE_MAX_BUDGET_USD)
    }

    return args
  }

  private resolveClaudeCliModel(): string | undefined {
    const configured = process.env.OPENCEPH_CLAUDE_CODE_MODEL
      ?? this.config.models.named.code_agent?.model.primary
    if (!configured || configured.includes("/")) {
      return undefined
    }
    return configured
  }

  private spawnProc(
    command: string,
    args: string[],
    options: {
      cwd: string
      env: NodeJS.ProcessEnv
      stdio: ["pipe", "pipe", "pipe"]
    },
  ): ChildProcessWithoutNullStreams {
    return (this.deps.spawn ?? defaultSpawn)(command, args, options)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private acquireRun(tentacleId: string, sessionFile: string): void {
    const existing = CodeAgent.activeRuns.get(tentacleId)
    if (existing) {
      throw new CodeAgentAlreadyRunningError(
        `Tentacle ${tentacleId} already has an active Claude Code session: ${existing.sessionFile}`,
        { tentacleId, sessionFile: existing.sessionFile },
      )
    }
    CodeAgent.activeRuns.set(tentacleId, { sessionFile, startedAt: this.now() })
  }

  private releaseRun(tentacleId: string, sessionFile: string): void {
    const existing = CodeAgent.activeRuns.get(tentacleId)
    if (existing?.sessionFile === sessionFile) {
      CodeAgent.activeRuns.delete(tentacleId)
    }
  }

  private async prepareWorkDir(tentacleId: string, mode: "generate" | "fix" | "merge"): Promise<string> {
    const workDir = path.join(
      os.homedir(),
      ".openceph",
      "agents",
      "code-agent",
      "work",
      tentacleId,
      `${mode}-${Date.now()}`,
    )
    await fs.mkdir(workDir, { recursive: true })
    return workDir
  }

  private async prepareSessionFile(tentacleId: string, mode: "generate" | "fix" | "merge"): Promise<string> {
    const baseDir = path.join(os.homedir(), ".openceph", "agents", "code-agent", "sessions")
    await fs.mkdir(baseDir, { recursive: true })
    return path.join(baseDir, `ca-${mode}-${tentacleId}-${Date.now()}.jsonl`)
  }
}

async function readPrompt(fileName: string): Promise<string> {
  const builtPath = path.join(__dirname, "prompts", fileName)
  const sourcePath = path.join(__dirname, "..", "..", "src", "code-agent", "prompts", fileName)
  const target = existsSync(builtPath) ? builtPath : sourcePath
  return fs.readFile(target, "utf-8")
}

function runtimePromptFile(runtime: string): string {
  if (runtime === "typescript") return "typescript-tentacle.md"
  if (runtime === "go") return "go-tentacle.md"
  if (runtime === "shell") return "shell-tentacle.md"
  return "python-tentacle.md"
}

function normalizeGeneratedCode(code: GeneratedCode, runtime: string): GeneratedCode {
  return {
    ...code,
    runtime: code.runtime || runtime,
    files: code.files ?? [],
    setupCommands: code.setupCommands ?? [],
    envVars: Array.from(new Set(code.envVars ?? ["OPENCEPH_SOCKET_PATH", "OPENCEPH_IPC_SOCKET", "OPENCEPH_TENTACLE_ID", "OPENCEPH_TRIGGER_MODE"])),
  }
}

function createJsonlWriter(filePath: string): {
  write: (event: Record<string, unknown>) => void
  close: () => Promise<void>
} {
  const stream = createWriteStream(filePath, { flags: "a" })
  let closed = false

  return {
    write(event) {
      if (closed) return
      stream.write(`${JSON.stringify(event)}\n`)
    },
    close() {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve, reject) => {
        stream.end((error?: Error | null) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function readGeneratedFiles(workDir: string): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = []
  await walkDir(workDir, workDir, files)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function walkDir(root: string, dir: string, files: Array<{ path: string; content: string }>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relPath = path.relative(root, fullPath)
    if (entry.isDirectory()) {
      if (["node_modules", "venv", "__pycache__", ".git", ".pytest_cache"].includes(entry.name)) continue
      await walkDir(root, fullPath, files)
      continue
    }
    if (shouldIgnoreGeneratedFile(relPath)) continue
    if (!isReadableTextFile(relPath)) continue
    files.push({
      path: relPath,
      content: await fs.readFile(fullPath, "utf-8"),
    })
  }
}

function shouldIgnoreGeneratedFile(relPath: string): boolean {
  return [
    ".DS_Store",
    ".openceph-prompt.md",
    "deploy.log",
    "generated-code.json",
    "tentacle.json",
    "package-lock.json",
  ].includes(path.basename(relPath))
}

function isReadableTextFile(relPath: string): boolean {
  return /\.(py|ts|js|tsx|jsx|go|sh|json|md|txt|yaml|yml|toml|ini|env)$/.test(relPath)
    || ["Dockerfile", "Makefile"].includes(path.basename(relPath))
}

function inferEntryCommand(runtime: string, files: Array<{ path: string; content: string }>): string {
  if (runtime === "typescript") {
    const entry = pickFirstExisting(files, ["src/main.ts", "main.ts", "src/index.ts", "index.ts"])
    if (!entry) throw new Error("Generated TypeScript project is missing an entry file")
    return `npx tsx ${entry}`
  }
  if (runtime === "go") {
    const entry = pickFirstExisting(files, ["main.go", "cmd/main.go", "cmd/openceph/main.go"])
    if (!entry) throw new Error("Generated Go project is missing main.go")
    return `go run ${entry}`
  }
  if (runtime === "shell") {
    const entry = pickFirstExisting(files, ["main.sh", "run.sh", "entrypoint.sh"])
    if (!entry) throw new Error("Generated shell project is missing a shell entry file")
    return `bash ${entry}`
  }

  const entry = pickFirstExisting(files, ["main.py", "src/main.py", "app.py"])
  if (!entry) throw new Error("Generated Python project is missing a Python entry file")
  const hasRequirements = files.some((file) => file.path === "requirements.txt")
  return hasRequirements ? `./venv/bin/python ${entry}` : `python3 ${entry}`
}

function inferSetupCommands(runtime: string, files: Array<{ path: string; content: string }>): string[] {
  if (runtime === "typescript") {
    return files.some((file) => file.path === "package.json") ? ["npm install"] : []
  }
  if (runtime === "python") {
    return files.some((file) => file.path === "requirements.txt")
      ? ["python3 -m venv venv", "venv/bin/pip install -r requirements.txt"]
      : []
  }
  if (runtime === "go") {
    return files.some((file) => file.path === "go.mod") ? ["go mod tidy"] : []
  }
  return []
}

function inferDependencies(runtime: string, files: Array<{ path: string; content: string }>): string | undefined {
  const target = runtime === "typescript"
    ? files.find((file) => file.path === "package.json")
    : runtime === "python"
      ? files.find((file) => file.path === "requirements.txt")
      : runtime === "go"
        ? files.find((file) => file.path === "go.mod")
        : undefined
  return target?.content
}

function inferEnvVars(requirement: CodeAgentRequirement): string[] {
  const vars = [
    "OPENCEPH_SOCKET_PATH",
    "OPENCEPH_IPC_SOCKET",
    "OPENCEPH_TENTACLE_ID",
    "OPENCEPH_TRIGGER_MODE",
  ]
  if (requirement.infrastructure?.needsLlm) {
    vars.push("OPENROUTER_API_KEY")
  }
  return Array.from(new Set(vars))
}

function pickFirstExisting(files: Array<{ path: string }>, candidates: string[]): string | undefined {
  const available = new Set(files.map((file) => file.path))
  return candidates.find((candidate) => available.has(candidate))
}

function summarizeValue(value: unknown): string {
  if (value === undefined) return ""
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > 800 ? `${text.slice(0, 800)}...` : text
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildEmergencyFallback(requirement: CodeAgentRequirement, runtime: string): GeneratedCode {
  const envVars = ["OPENCEPH_SOCKET_PATH", "OPENCEPH_IPC_SOCKET", "OPENCEPH_TENTACLE_ID", "OPENCEPH_TRIGGER_MODE"]
  if (runtime === "typescript") {
    return {
      runtime,
      files: [{
        path: "src/main.ts",
        content: `import * as crypto from "node:crypto"
import * as net from "node:net"

const socketPath = process.env.OPENCEPH_SOCKET_PATH ?? process.env.OPENCEPH_IPC_SOCKET ?? ""
const triggerMode = process.env.OPENCEPH_TRIGGER_MODE ?? "external"
const id = process.env.OPENCEPH_TENTACLE_ID ?? ${JSON.stringify(requirement.tentacleId)}
let stopped = false
let paused = false
let buffer = ""

function send(type: string, payload: Record<string, unknown>) {
  socket.write(JSON.stringify({
    type,
    sender: id,
    receiver: "brain",
    payload,
    timestamp: new Date().toISOString(),
    message_id: crypto.randomUUID(),
  }) + "\\n")
}

function emitConsultation(reason: string, mode: "batch" | "action_confirm" = "batch") {
  send("consultation_request", {
    tentacle_id: id,
    request_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    turn: 1,
    mode,
    summary: "Emergency fallback consultation",
    context: \`reason=\${reason}; trigger=\${triggerMode}\`,
    items: mode === "batch" ? [{
      id: "fallback-item",
      content: ${JSON.stringify(requirement.workflow || requirement.purpose)},
      tentacleJudgment: "important",
      reason: "OpenCeph emergency fallback",
      timestamp: new Date().toISOString(),
    }] : undefined,
    action: mode === "action_confirm" ? {
      type: "review_result",
      description: "User confirmation required",
      content: "OpenCeph fallback action",
    } : undefined,
  })
}

const socket = net.createConnection(socketPath, () => {
  send("tentacle_register", { purpose: ${JSON.stringify(requirement.purpose)}, runtime: "typescript", triggerMode })
  emitConsultation("boot")
})

socket.on("data", (chunk) => {
  buffer += chunk.toString("utf-8")
  const lines = buffer.split("\\n")
  buffer = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.type !== "directive") continue
    const action = message.payload?.action
    if (action === "pause") paused = true
    if (action === "resume") paused = false
    if (action === "run_now" && !paused) emitConsultation("run_now")
    if (action === "consultation_followup" && !paused) emitConsultation("followup", "action_confirm")
    if (action === "kill") {
      stopped = true
      socket.end(() => process.exit(0))
    }
  }
})

socket.on("error", () => {
  process.exit(stopped ? 0 : 1)
})

setInterval(() => {
  if (!paused && !stopped && triggerMode === "self") emitConsultation("self_schedule")
}, 60_000)
`,
      }, {
        path: "package.json",
        content: JSON.stringify({
          name: requirement.tentacleId,
          private: true,
          type: "module",
          devDependencies: { tsx: "^4.21.0", typescript: "^5.9.3", "@types/node": "^22.0.0" },
        }, null, 2),
      }],
      entryCommand: "npx tsx src/main.ts",
      setupCommands: ["npm install"],
      envVars,
      description: `Emergency fallback tentacle for ${requirement.purpose}`,
    }
  }

  return {
    runtime: "python",
    files: [{
      path: "main.py",
      content: `import json
import os
import socket
import sys
import threading
import time
import uuid

STOP = False
PAUSED = False
SOCKET_PATH = os.environ.get("OPENCEPH_SOCKET_PATH") or os.environ.get("OPENCEPH_IPC_SOCKET") or ""
TRIGGER_MODE = os.environ.get("OPENCEPH_TRIGGER_MODE", "external")
TENTACLE_ID = os.environ.get("OPENCEPH_TENTACLE_ID", ${JSON.stringify(requirement.tentacleId)})
PURPOSE = ${JSON.stringify(requirement.purpose)}
WORKFLOW = ${JSON.stringify(requirement.workflow || requirement.purpose)}

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(SOCKET_PATH)

def send(msg_type, payload):
    sock.sendall((json.dumps({
        "type": msg_type,
        "sender": TENTACLE_ID,
        "receiver": "brain",
        "payload": payload,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "message_id": str(uuid.uuid4())
    }) + "\\n").encode("utf-8"))

def emit_consultation(reason, mode="batch"):
    payload = {
        "tentacle_id": TENTACLE_ID,
        "request_id": str(uuid.uuid4()),
        "session_id": str(uuid.uuid4()),
        "turn": 1,
        "mode": mode,
        "summary": "Emergency fallback consultation",
        "context": f"reason={reason}; trigger={TRIGGER_MODE}",
    }
    if mode == "action_confirm":
        payload["action"] = {
            "type": "review_result",
            "description": "User confirmation required",
            "content": "OpenCeph fallback action",
        }
    else:
        payload["items"] = [{
            "id": "fallback-item",
            "content": WORKFLOW,
            "tentacleJudgment": "important",
            "reason": "OpenCeph emergency fallback",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }]
    send("consultation_request", payload)

def handle_directive(message):
    global STOP, PAUSED
    action = (message.get("payload") or {}).get("action")
    if action == "pause":
        PAUSED = True
    elif action == "resume":
        PAUSED = False
    elif action == "run_now":
        if not PAUSED:
            emit_consultation("run_now")
    elif action == "consultation_followup":
        if not PAUSED:
            emit_consultation("followup", "action_confirm")
    elif action == "kill":
        STOP = True
        try:
            sock.close()
        finally:
            sys.exit(0)

def reader():
    global STOP
    buffer = ""
    while not STOP:
        data = sock.recv(4096)
        if not data:
            break
        buffer += data.decode("utf-8")
        parts = buffer.split("\\n")
        buffer = parts.pop() or ""
        for part in parts:
            if not part.strip():
                continue
            message = json.loads(part)
            if message.get("type") == "directive":
                handle_directive(message)

send("tentacle_register", {"purpose": PURPOSE, "runtime": "python", "triggerMode": TRIGGER_MODE})
emit_consultation("boot")
threading.Thread(target=reader, daemon=True).start()

while not STOP:
    if TRIGGER_MODE == "self" and not PAUSED:
        time.sleep(60)
        emit_consultation("self_schedule")
    else:
        time.sleep(0.1)
`,
    }],
    entryCommand: "python3 main.py",
    setupCommands: [],
    envVars,
    description: `Emergency fallback tentacle for ${requirement.purpose}`,
  }
}

function buildEmergencyPatch(existingCode: string, patchRequirement: PatchRequirement): CodePatch {
  const files = parseAggregatedFiles(existingCode)
  const target = files.find((file) => /main\.(py|ts|go|sh)$/.test(file.path)) ?? files[0]
  if (!target) {
    return {
      files: buildPatchFiles([], patchRequirement),
      description: patchRequirement.description,
    }
  }
  return {
    files: buildPatchFiles([target], patchRequirement),
    description: patchRequirement.description,
  }
}

function parseAggregatedFiles(existingCode: string): { path: string; content: string }[] {
  const matches = Array.from(existingCode.matchAll(/--- ([^\n]+) ---\n([\s\S]*?)(?=(?:\n--- [^\n]+ ---)|$)/g))
  return matches.map((match) => ({ path: match[1].trim(), content: match[2] }))
}

function shouldUseEmergencyFallback(): boolean {
  if (process.env.OPENCEPH_CODE_AGENT_FORCE_CLAUDE_CLI === "1") {
    return false
  }
  return process.env.OPENCEPH_CODE_AGENT_EMERGENCY_FALLBACK === "1" || process.env.VITEST === "true"
}

function buildPatchFiles(
  targets: { path: string; content: string }[],
  patchRequirement: PatchRequirement,
): CodePatch["files"] {
  const files: CodePatch["files"] = targets.map((target) => ({
    path: target.path,
    action: "replace",
    content: appendUpgradeMarker(target.path, target.content, patchRequirement.description),
  }))
  files.push({
    path: "UPGRADE_NOTES.md",
    action: "replace",
    content: [
      "# OpenCeph upgrade",
      "",
      `Tentacle: ${patchRequirement.tentacleId}`,
      "",
      `Description: ${patchRequirement.description}`,
      patchRequirement.newFrequency ? `Frequency: ${patchRequirement.newFrequency}` : "",
      patchRequirement.additionalCapabilities?.length
        ? `Capabilities: ${patchRequirement.additionalCapabilities.join(", ")}`
        : "",
    ].filter(Boolean).join("\n"),
  })
  return files
}

function appendUpgradeMarker(filePath: string, content: string, description: string): string {
  const suffix = filePath.endsWith(".ts") || filePath.endsWith(".js") || filePath.endsWith(".go")
    ? `// OpenCeph upgrade: ${description}`
    : `# OpenCeph upgrade: ${description}`
  return `${content.trimEnd()}\n\n${suffix}\n`
}
