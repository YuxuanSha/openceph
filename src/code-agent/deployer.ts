import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import type { GeneratedCode } from "./code-agent.js"

export class TentacleDeployer {
  constructor(private baseDir: string) {}

  async deploy(tentacleId: string, code: GeneratedCode, metadata?: {
    purpose?: string
    trigger?: string
    dataSources?: string[]
  }): Promise<string> {
    const targetDir = path.join(this.baseDir, tentacleId)
    await fs.mkdir(targetDir, { recursive: true })

    for (const file of code.files) {
      const fullPath = path.join(targetDir, file.path)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, file.content, "utf-8")
      if (file.path.endsWith(".sh")) {
        await fs.chmod(fullPath, 0o755)
      }
    }

    for (const command of code.setupCommands) {
      await runShell(command, targetDir)
    }

    await fs.writeFile(path.join(targetDir, "tentacle.json"), JSON.stringify({
      tentacleId,
      purpose: metadata?.purpose ?? "Generated tentacle",
      runtime: code.runtime,
      entryCommand: code.entryCommand,
      cwd: targetDir,
      source: "code-agent",
      trigger: metadata?.trigger ?? "manual",
      dataSources: metadata?.dataSources ?? [],
      createdAt: new Date().toISOString(),
    }, null, 2), "utf-8")

    return targetDir
  }
}

function runShell(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("bash", ["-lc", command], { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message))
      } else {
        resolve()
      }
    })
  })
}
