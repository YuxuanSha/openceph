import { execFile } from "child_process"
import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import type { OpenCephConfig } from "../config/config-schema.js"
import { brainLogger, systemLogger } from "../logger/index.js"
import type { RuntimeAvailability } from "../tentacle/runtime-detector.js"
import { SkillInspector } from "./skill-inspector.js"
import { SkillLoader } from "./skill-loader.js"
import { TentacleManager } from "../tentacle/manager.js"

export interface SpawnResult {
  tentacleId: string
  skillName: string
  runtime: string
  directory: string
  trigger: string
}

export class SkillSpawner {
  constructor(
    private config: OpenCephConfig,
    private skillLoader: SkillLoader,
    private tentacleManager: TentacleManager,
    private runtimeDetector: RuntimeAvailability,
  ) {}

  async spawn(
    skillName: string,
    tentacleId: string,
    triggerOverride?: string,
    extraConfig?: Record<string, unknown>,
  ): Promise<SpawnResult> {
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
      throw new Error(validation.errors.join("; "))
    }

    const runtime = normalizeRuntime(skill.tentacleConfig?.runtime)
    if (!isRuntimeAvailable(runtime, this.runtimeDetector)) {
      throw new Error(`Runtime unavailable for ${skillName}: ${runtime}`)
    }

    const tentacleDir = this.tentacleManager.getTentacleDir(tentacleId)
    const trigger = triggerOverride ?? skill.tentacleConfig?.defaultTrigger ?? "manual"
    const entry = skill.tentacleConfig?.entry
    if (!entry) {
      throw new Error(`Skill missing entry: ${skillName}`)
    }

    systemLogger.info("skill_spawn_start", { skill_name: skillName, tentacle_id: tentacleId })
    brainLogger.info("skill_spawn_start", { skill_name: skillName, tentacle_id: tentacleId })

    await fs.mkdir(tentacleDir, { recursive: true })
    await copyDir(skill.path, tentacleDir)
    await this.writeEnvFile(tentacleDir, extraConfig)
    await this.runSetupCommands(tentacleDir, runtime)

    const entryCommand = buildEntryCommand(runtime, entry, tentacleDir)
    await fs.writeFile(
      path.join(tentacleDir, "tentacle.json"),
      JSON.stringify({
        tentacleId,
        purpose: skill.description || skill.name,
        runtime,
        entryCommand,
        cwd: tentacleDir,
        source: `skill:${skill.name} v${skill.version}`,
        trigger,
        dataSources: extraConfig?.dataSources ?? [],
        createdAt: new Date().toISOString(),
        skillName,
      }, null, 2),
      "utf-8",
    )

    try {
      await this.tentacleManager.spawn(tentacleId)
      const registered = await this.tentacleManager.waitForRegistration(tentacleId, 30_000)
      if (!registered) {
        throw new Error(`Timed out waiting for tentacle registration: ${tentacleId}`)
      }
      systemLogger.info("skill_spawn_success", { skill_name: skillName, tentacle_id: tentacleId })
      brainLogger.info("skill_spawn_success", { skill_name: skillName, tentacle_id: tentacleId })
      return {
        tentacleId,
        skillName,
        runtime,
        directory: tentacleDir,
        trigger,
      }
    } catch (error) {
      systemLogger.error("skill_spawn_failed", {
        skill_name: skillName,
        tentacle_id: tentacleId,
        error: error instanceof Error ? error.message : String(error),
      })
      brainLogger.error("skill_spawn_failed", {
        skill_name: skillName,
        tentacle_id: tentacleId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  private async writeEnvFile(tentacleDir: string, extraConfig?: Record<string, unknown>): Promise<void> {
    const lines = [
      `OPENCEPH_SOCKET_PATH=${this.config.tentacle.ipcSocketPath}`,
      `OPENCEPH_CREATED_AT=${new Date().toISOString()}`,
    ]

    if (extraConfig) {
      for (const [key, value] of Object.entries(extraConfig)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          lines.push(`${key.toUpperCase()}=${String(value)}`)
        }
      }
    }

    await fs.writeFile(path.join(tentacleDir, ".env"), `${lines.join("\n")}\n`, "utf-8")
  }

  private async runSetupCommands(tentacleDir: string, runtime: string): Promise<void> {
    const commands: string[] = []
    const skillMdPath = path.join(tentacleDir, "SKILL.md")
    if (existsSync(skillMdPath)) {
      const { SkillInspector } = await import("./skill-inspector.js")
      const rawSkill = await fs.readFile(skillMdPath, "utf-8")
      const parsedSkill = SkillInspector.parse(rawSkill)
      commands.push(...(parsedSkill.tentacleConfig?.setupCommands ?? []))
    }
    if (runtime === "python" && existsSync(path.join(tentacleDir, "requirements.txt"))) {
      if (!commands.includes("python3 -m venv venv")) {
        commands.push("python3 -m venv venv")
      }
      commands.push("venv/bin/pip install -r requirements.txt")
    }
    if (runtime === "typescript" && existsSync(path.join(tentacleDir, "package.json"))) {
      if (!commands.includes("npm install")) {
        commands.push("npm install")
      }
    }

    for (const command of [...new Set(commands)]) {
      await runShell(command, tentacleDir, 120_000)
    }
  }
}

async function copyDir(sourceDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true })
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destPath)
    } else {
      await fs.copyFile(sourcePath, destPath)
    }
  }
}

function buildEntryCommand(runtime: string, entry: string, tentacleDir: string): string {
  const quoted = JSON.stringify(entry)
  if (runtime === "python") {
    const python = existsSync(path.join(tentacleDir, "venv", "bin", "python"))
      ? "./venv/bin/python"
      : "python3"
    return `${python} ${quoted}`
  }
  if (runtime === "typescript") {
    return `npx tsx ${quoted}`
  }
  if (runtime === "go") {
    return `go run ${quoted}`
  }
  if (runtime === "shell") {
    return `bash ${quoted}`
  }
  return `python3 ${quoted}`
}

function normalizeRuntime(runtime?: string): string {
  if (!runtime) return "python"
  if (runtime === "py") return "python"
  if (runtime === "ts") return "typescript"
  return runtime
}

function isRuntimeAvailable(runtime: string, availability: RuntimeAvailability): boolean {
  if (runtime === "python") return availability.python3
  if (runtime === "typescript") return availability.node
  if (runtime === "go") return availability.go
  if (runtime === "shell") return availability.bash
  return true
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("bash", ["-lc", command], { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${stderr || stdout || error.message}`))
        return
      }
      resolve()
    })
  })
}
