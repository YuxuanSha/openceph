import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import { SessionStoreManager } from "../session/session-store.js"
import type { ToolRegistryEntry } from "./index.js"

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined }
}

export function createSessionTools(agentId: string): ToolRegistryEntry[] {
  const sessionStore = new SessionStoreManager(agentId)

  const sessionsList: ToolDefinition = {
    name: "sessions_list",
    label: "Sessions List",
    description: "列出最近活跃的 session",
    promptSnippet: "sessions_list — 列出最近活跃的 session",
    parameters: Type.Object({
      active_within_minutes: Type.Optional(Type.Number({ default: 1440 })),
      limit: Type.Optional(Type.Number({ default: 20 })),
    }),
    async execute(_id, params: any) {
      const sessions = await sessionStore.list({
        activeWithinMinutes: params.active_within_minutes ?? 1440,
      })
      const limit = params.limit ?? 20
      const rows = sessions
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map((session) =>
          `${session.sessionKey}\n` +
          `  sessionId=${session.sessionId}\n` +
          `  model=${session.model ?? "unknown"}\n` +
          `  updatedAt=${session.updatedAt}\n` +
          `  tokens=${session.totalTokens}`
        )

      return ok(rows.length > 0 ? rows.join("\n\n") : "No active sessions found.")
    },
  }

  const sessionsHistory: ToolDefinition = {
    name: "sessions_history",
    label: "Sessions History",
    description: "查看指定 session 的最近历史消息",
    promptSnippet: "sessions_history — 查看指定 session 的最近消息",
    parameters: Type.Object({
      session_key: Type.String({ description: "session key，如 agent:ceph:main" }),
      limit: Type.Optional(Type.Number({ default: 20 })),
      include_tools: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, params: any) {
      const sessions = await sessionStore.list()
      const target = sessions.find((session) => session.sessionKey === params.session_key)
      if (!target) {
        return ok(`Session not found: ${params.session_key}`)
      }

      const transcriptPath = sessionStore.getTranscriptPath(target.sessionId)
      let raw = ""
      try {
        const fs = await import("fs/promises")
        raw = await fs.readFile(transcriptPath, "utf-8")
      } catch {
        return ok(`Transcript not found for session: ${params.session_key}`)
      }

      const includeTools = params.include_tools ?? false
      const limit = params.limit ?? 20
      const rows = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((item): item is Record<string, unknown> => item !== null)
        .filter((item) => {
          if (includeTools) return true
          const role = typeof item.role === "string" ? item.role : ""
          return role === "user" || role === "assistant"
        })
        .slice(-limit)
        .map((item, index) => {
          const role = typeof item.role === "string" ? item.role : "unknown"
          const content = typeof item.content === "string"
            ? item.content
            : JSON.stringify(item.content)
          return `${index + 1}. [${role}] ${content.slice(0, 800)}`
        })

      return ok(rows.length > 0 ? rows.join("\n\n") : "No transcript entries found.")
    },
  }

  return [
    { name: "sessions_list", description: sessionsList.description, group: "sessions", tool: sessionsList },
    { name: "sessions_history", description: sessionsHistory.description, group: "sessions", tool: sessionsHistory },
  ]
}
