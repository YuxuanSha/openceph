import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"

export interface TentacleRegistryEntry {
  tentacleId: string
  status: string
  purpose: string
  source?: string
  runtime?: string
  trigger?: string
  dataSources?: string
  createdAt: string
  directory?: string
  lastReport?: string
  health?: string
  scheduleConfig?: string
}

export class TentacleRegistry {
  private registryPath: string

  constructor(private workspaceDir: string) {
    this.registryPath = path.join(workspaceDir, "TENTACLES.md")
  }

  async readAll(): Promise<TentacleRegistryEntry[]> {
    if (!existsSync(this.registryPath)) return []
    const content = await fs.readFile(this.registryPath, "utf-8")
    return parseRegistry(content)
  }

  async register(entry: TentacleRegistryEntry): Promise<void> {
    const entries = await this.readAll()
    const next = entries.filter((item) => item.tentacleId !== entry.tentacleId)
    next.push(entry)
    await this.writeAll(next)
  }

  async updateStatus(tentacleId: string, status: string, extraFields?: Record<string, string>): Promise<void> {
    const entries = await this.readAll()
    const updated = entries.map((entry) =>
      entry.tentacleId === tentacleId
        ? {
            ...entry,
            status,
            purpose: extraFields?.purpose ?? entry.purpose,
            source: extraFields?.source ?? entry.source,
            runtime: extraFields?.runtime ?? entry.runtime,
            trigger: extraFields?.trigger ?? entry.trigger,
            dataSources: extraFields?.dataSources ?? entry.dataSources,
            directory: extraFields?.directory ?? entry.directory,
            lastReport: extraFields?.lastReport ?? entry.lastReport,
            health: extraFields?.health ?? entry.health,
            scheduleConfig: extraFields?.scheduleConfig ?? entry.scheduleConfig,
          }
        : entry
    )
    await this.writeAll(updated)
  }

  async markKilled(tentacleId: string): Promise<void> {
    await this.updateStatus(tentacleId, "killed")
  }

  private async writeAll(entries: TentacleRegistryEntry[]): Promise<void> {
    const running = entries.filter((entry) => entry.status === "running" || entry.status === "paused")
    const stopped = entries.filter((entry) => !running.includes(entry))

    const renderEntry = (entry: TentacleRegistryEntry) => [
      `### ${entry.tentacleId}`,
      `- **状态：** ${entry.status}`,
      `- **目的：** ${entry.purpose}`,
      `- **来源：** ${entry.source ?? "manual"}`,
      `- **运行时：** ${entry.runtime ?? "unknown"}`,
      `- **触发：** ${entry.trigger ?? "manual"}`,
      `- **数据源：** ${entry.dataSources ?? "-"}`,
      `- **创建：** ${entry.createdAt}`,
      `- **目录：** ${entry.directory ?? "-"}`,
      `- **最后上报：** ${entry.lastReport ?? "-"}`,
      `- **健康度：** ${entry.health ?? "-"}`,
      `- **调度：** ${entry.scheduleConfig ?? "-"}`,
    ].join("\n")

    const content = [
      "# TENTACLES.md — 触手注册表",
      "",
      "## 运行中的触手",
      running.length > 0 ? running.map(renderEntry).join("\n\n") : "（无）",
      "",
      "## 已停用的触手",
      stopped.length > 0 ? stopped.map(renderEntry).join("\n\n") : "（无）",
      "",
    ].join("\n")

    await fs.mkdir(this.workspaceDir, { recursive: true })
    await fs.writeFile(this.registryPath, content, "utf-8")
  }
}

function parseRegistry(content: string): TentacleRegistryEntry[] {
  const entries: TentacleRegistryEntry[] = []
  const chunks = content.split(/^### /m).slice(1)
  for (const chunk of chunks) {
    const lines = chunk.split("\n")
    const tentacleId = lines[0].trim()
    const record: TentacleRegistryEntry = {
      tentacleId,
      status: "unknown",
      purpose: "",
      createdAt: new Date(0).toISOString(),
    }
    for (const line of lines.slice(1)) {
      const match = line.match(/^- \*\*(.+?)：\*\* (.*)$/)
      if (!match) continue
      const key = match[1]
      const value = match[2]
      if (key === "状态") record.status = value
      if (key === "目的") record.purpose = value
      if (key === "来源") record.source = value
      if (key === "运行时") record.runtime = value
      if (key === "触发") record.trigger = value
      if (key === "数据源") record.dataSources = value
      if (key === "创建") record.createdAt = value
      if (key === "目录") record.directory = value
      if (key === "最后上报") record.lastReport = value
      if (key === "健康度") record.health = value
      if (key === "调度") record.scheduleConfig = value
    }
    entries.push(record)
  }
  return entries
}
