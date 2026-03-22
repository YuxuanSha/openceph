import type { CommandExecutor, CommandContext } from "./command-handler.js"
import * as fs from "fs/promises"
import * as path from "path"

const WORKSPACE_FILES = [
  "SOUL.md",
  "AGENTS.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "TENTACLES.md",
  "MEMORY.md",
]

export const contextCommand: CommandExecutor = {
  async execute(args: string[], ctx: CommandContext): Promise<string> {
    const mode = args[0] ?? "list"
    const workspaceDir = ctx.config.agents.defaults.workspace

    if (mode === "detail") {
      const file = args[1] ?? "TOOLS.md"
      const filePath = path.join(workspaceDir, file)
      const content = await fs.readFile(filePath, "utf-8").catch(() => null)
      return content ?? `Context file not found: ${file}`
    }

    const fileSummaries = await Promise.all(WORKSPACE_FILES.map(async (file) => {
      const filePath = path.join(workspaceDir, file)
      try {
        const stat = await fs.stat(filePath)
        return `${file} (${stat.size} bytes)`
      } catch {
        return `${file} (missing)`
      }
    }))
    const skills = await ctx.brain.listSkills()
    const tools = ctx.brain.listToolNames()

    return [
      "Workspace files:",
      ...fileSummaries.map((line) => `- ${line}`),
      "",
      `Skills: ${skills.length === 0 ? "none" : skills.join(", ")}`,
      `Tools: ${tools.join(", ")}`,
    ].join("\n")
  },
}
