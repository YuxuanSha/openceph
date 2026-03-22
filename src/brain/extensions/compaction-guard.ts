/**
 * Pi Extension: Compaction Guard
 * Hook: session_before_compact
 * Flushes important memory before compaction and protects critical messages.
 */
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

const compactionGuard: ExtensionFactory = (pi) => {
  const workspaceDir = path.join(os.homedir(), ".openceph", "workspace")

  pi.on("session_before_compact", async (event) => {
    const today = new Date().toISOString().slice(0, 10)
    const dailyLogPath = path.join(workspaceDir, "memory", `${today}.md`)
    try {
      const entries = event.branchEntries || []
      const keyPoints: string[] = []

      for (const entry of entries) {
        const data = entry as any
        if (data.toolName && data.isError) {
          keyPoints.push(`- Tool failure: ${data.toolName}`)
        }
        if (data.toolName === "send_to_user") {
          keyPoints.push(`- Push history: ${JSON.stringify(data.toolInput ?? {}).slice(0, 240)}`)
        }
        if (data.toolName === "spawn_from_skill" || data.toolName === "create_tentacle") {
          const tid = data.toolInput?.tentacle_id ?? data.toolInput?.tentacleId ?? "?"
          keyPoints.push(`- Tentacle created: ${tid}`)
        }
        if (data.toolName === "manage_tentacle") {
          const action = data.toolInput?.action
          if (action === "kill" || action === "merge") {
            const ids = (data.toolInput?.tentacle_ids ?? []).join(", ")
            keyPoints.push(`- Tentacle ${action}: ${ids}`)
          }
        }
        if (typeof data.content === "string" && /consultation/i.test(data.content)) {
          keyPoints.push(`- Consultation summary: ${data.content.slice(0, 200)}`)
        }
        if (typeof data.content === "string") {
          const text = data.content.toLowerCase()
          if (text.includes("记住") || text.includes("记下来") || text.includes("remember")) {
            keyPoints.push(`- User requested memory: ${data.content.slice(0, 200)}`)
          }
        }
      }

      if (keyPoints.length > 0) {
        await fs.mkdir(path.dirname(dailyLogPath), { recursive: true })
        const block = `\n## Pre-compaction flush @ ${new Date().toISOString()}\n${keyPoints.join("\n")}\n`
        const prefix = await fileExists(dailyLogPath) ? "" : `# Memory Log ${today}\n`
        await fs.appendFile(dailyLogPath, `${prefix}${block}`, "utf-8")
      }
    } catch {
      // Non-fatal: allow compaction to proceed
    }

    // Don't cancel compaction
    return {}
  })
}

export default compactionGuard

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}
