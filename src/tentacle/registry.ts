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
      `- **Status:** ${entry.status}`,
      `- **Purpose:** ${entry.purpose}`,
      `- **Source:** ${entry.source ?? "manual"}`,
      `- **Runtime:** ${entry.runtime ?? "unknown"}`,
      `- **Trigger:** ${entry.trigger ?? "manual"}`,
      `- **Data Sources:** ${entry.dataSources ?? "-"}`,
      `- **Created:** ${entry.createdAt}`,
      `- **Directory:** ${entry.directory ?? "-"}`,
      `- **Last Report:** ${entry.lastReport ?? "-"}`,
      `- **Health:** ${entry.health ?? "-"}`,
      `- **Schedule:** ${entry.scheduleConfig ?? "-"}`,
    ].join("\n")

    const content = [
      "# TENTACLES.md — Tentacle Registry",
      "",
      "## Running Tentacles",
      running.length > 0 ? running.map(renderEntry).join("\n\n") : "(none)",
      "",
      "## Stopped Tentacles",
      stopped.length > 0 ? stopped.map(renderEntry).join("\n\n") : "(none)",
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
      const match = line.match(/^- \*\*(.+?):\*\* (.*)$/)
      if (!match) continue
      const key = match[1]
      const value = match[2]
      if (key === "Status") record.status = value
      if (key === "Purpose") record.purpose = value
      if (key === "Source") record.source = value
      if (key === "Runtime") record.runtime = value
      if (key === "Trigger") record.trigger = value
      if (key === "Data Sources") record.dataSources = value
      if (key === "Created") record.createdAt = value
      if (key === "Directory") record.directory = value
      if (key === "Last Report") record.lastReport = value
      if (key === "Health") record.health = value
      if (key === "Schedule") record.scheduleConfig = value
    }
    entries.push(record)
  }
  return entries
}
