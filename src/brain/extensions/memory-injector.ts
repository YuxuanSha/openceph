/**
 * Pi Extension: Memory Injector
 * Hook: before_agent_start
 * Reads MEMORY.md + USER.md and injects into system prompt.
 */
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

const memoryInjector: ExtensionFactory = (pi) => {
  const workspaceDir = path.join(os.homedir(), ".openceph", "workspace")
  const maxChars = 20000

  pi.on("before_agent_start", async (event) => {
    let systemPrompt = event.systemPrompt

    // Inject MEMORY.md summary
    try {
      let memoryContent = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8")
      if (memoryContent.length > maxChars) {
        memoryContent = memoryContent.slice(0, maxChars) + "\n<!-- truncated -->"
      }
      if (memoryContent.trim()) {
        systemPrompt += `\n\n---\n\n# [Memory Context]\n${memoryContent}`
      }
    } catch { /* MEMORY.md not found, skip */ }

    // Inject USER.md
    try {
      let userContent = await fs.readFile(path.join(workspaceDir, "USER.md"), "utf-8")
      if (userContent.length > maxChars) {
        userContent = userContent.slice(0, maxChars) + "\n<!-- truncated -->"
      }
      if (userContent.trim()) {
        systemPrompt += `\n\n---\n\n# [User Profile]\n${userContent}`
      }
    } catch { /* USER.md not found, skip */ }

    return { systemPrompt }
  })
}

export default memoryInjector
