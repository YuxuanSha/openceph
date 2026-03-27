import { createReadOnlyTools } from "@mariozechner/pi-coding-agent"
import type { ToolRegistryEntry } from "./index.js"

const WORKSPACE_TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "读取 workspace 文件内容；适用于 SOUL.md、AGENTS.md、USER.md、HEARTBEAT.md、memory/*.md 等",
  grep: "在 workspace 内按关键词搜索文件内容，返回文件路径与行号",
  find: "在 workspace 内按 glob 查找文件路径",
  ls: "列出 workspace 目录内容",
}

export function createWorkspaceTools(workspaceDir: string): ToolRegistryEntry[] {
  return createReadOnlyTools(workspaceDir).map((tool) => ({
    name: tool.name,
    description: WORKSPACE_TOOL_DESCRIPTIONS[tool.name] ?? tool.description,
    group: "workspace",
    tool,
  }))
}
