import { createReadOnlyTools } from "@mariozechner/pi-coding-agent"
import type { ToolRegistryEntry } from "./index.js"

const WORKSPACE_TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "Read workspace file contents; suitable for SOUL.md, AGENTS.md, USER.md, HEARTBEAT.md, memory/*.md, etc.",
  grep: "Search file contents by keyword within the workspace, returning file paths and line numbers",
  find: "Find file paths within the workspace by glob pattern",
  ls: "List workspace directory contents",
}

export function createWorkspaceTools(workspaceDir: string): ToolRegistryEntry[] {
  return createReadOnlyTools(workspaceDir).map((tool) => ({
    name: tool.name,
    description: WORKSPACE_TOOL_DESCRIPTIONS[tool.name] ?? tool.description,
    group: "workspace",
    tool,
  }))
}
