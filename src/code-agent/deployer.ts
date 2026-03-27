import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import type { GeneratedCode } from "./code-agent.js"
import type { TentacleScheduleConfig } from "../tentacle/tentacle-schedule.js"

export interface DeployMetadata {
  purpose?: string
  trigger?: string
  skillName?: string
  brief?: string
}

export class TentacleDeployer {
  constructor(private baseDir: string) {}

  async deploy(tentacleId: string, code: GeneratedCode, metadata?: DeployMetadata): Promise<string> {
    const targetDir = path.join(this.baseDir, tentacleId)
    await fs.mkdir(targetDir, { recursive: true })
    await clearDirectoryExcept(targetDir, new Set([".env", "data", "tentacle.json", "tentacle.log", "deploy.log"]))
    const deployLogPath = path.join(targetDir, "deploy.log")

    // Write all generated files
    for (const file of code.files) {
      const fullPath = path.join(targetDir, file.path)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, file.content, "utf-8")
      if (file.path.endsWith(".sh")) {
        await fs.chmod(fullPath, 0o755)
      }
    }

    // Write .env file with required environment variables
    if (code.envVars?.length) {
      const envLines = code.envVars.map((v) => `${v}=`).join("\n")
      const envPath = path.join(targetDir, ".env")
      await fs.writeFile(envPath, `# Environment variables for ${tentacleId}\n${envLines}\n`, "utf-8")
    }

    // Run setup commands
    for (const command of code.setupCommands) {
      const output = await runShell(command, targetDir)
      await fs.appendFile(deployLogPath, `\n$ ${command}\n${output}\n`, "utf-8")
    }

    await assertRequestedPortsAvailable(code.ports)

    await fs.writeFile(path.join(targetDir, "generated-code.json"), JSON.stringify(code, null, 2), "utf-8")

    const entryPath = resolveEntryRelativePath(code.entryCommand)
    if (entryPath) {
      const fullEntryPath = path.join(targetDir, entryPath)
      try {
        await fs.access(fullEntryPath)
      } catch {
        const files = await listFiles(targetDir)
        throw new Error(
          `部署失败：入口文件 ${entryPath} 不存在于 ${targetDir}。实际文件：${files.join(", ") || "(empty)"}`,
        )
      }
    }

    // Write tentacle.json metadata
    await fs.writeFile(path.join(targetDir, "tentacle.json"), JSON.stringify({
      tentacleId,
      purpose: metadata?.purpose ?? "Generated tentacle",
      runtime: code.runtime,
      entryCommand: code.entryCommand,
      cwd: targetDir,
      source: metadata?.skillName ? `skill:${metadata.skillName}` : "code-agent",
      trigger: metadata?.trigger ?? "manual",
      createdAt: new Date().toISOString(),
      scheduleConfig: buildScheduleConfig(metadata?.trigger),
      brief: metadata?.brief,
      envVars: code.envVars,
      ports: code.ports,
      description: code.description,
      setupCommands: code.setupCommands,
      dependencies: code.dependencies,
    }, null, 2), "utf-8")

    return targetDir
  }
}

async function clearDirectoryExcept(targetDir: string, preserve: Set<string>): Promise<void> {
  const entries = await fs.readdir(targetDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (preserve.has(entry.name)) continue
    await fs.rm(path.join(targetDir, entry.name), { recursive: true, force: true })
  }
}

function resolveEntryRelativePath(entryCommand: string): string | null {
  const candidates = entryCommand
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => /\.(py|ts|js|go|sh)$/.test(part))

  return candidates.at(-1) ?? null
}

async function listFiles(targetDir: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string, prefix = ""): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel)
      } else {
        files.push(rel)
      }
    }
  }
  await walk(targetDir)
  return files.sort()
}

function buildScheduleConfig(trigger?: string): TentacleScheduleConfig {
  if (trigger && /^\d+(?:ms|s|m|h|d|w)$/.test(trigger)) {
    return { primaryTrigger: { type: "self-schedule", interval: trigger }, cronJobs: [] }
  }
  return { primaryTrigger: { type: "self-schedule", interval: "6h" }, cronJobs: [] }
}

function runShell(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("bash", ["-lc", command], { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message))
      } else {
        resolve(`${stdout}${stderr}`.trim())
      }
    })
  })
}

async function assertRequestedPortsAvailable(ports?: number[]): Promise<void> {
  if (!ports?.length) return
  const { createServer } = await import("net")
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const server = createServer()
      server.once("error", (error) => reject(new Error(`Requested port ${port} is unavailable: ${(error as Error).message}`)))
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve())
      })
    })
  }
}
