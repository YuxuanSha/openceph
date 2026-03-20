import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"

export interface PendingReport {
  findingId: string
  tentacleId: string
  summary: string
  confidence: number
  createdAt: string
  status: "pending" | "sent" | "discarded"
}

export class PendingReportsQueue {
  constructor(private statePath: string) {}

  async add(report: PendingReport): Promise<void> {
    const reports = await this.getAll()
    reports.push(report)
    await this.write(reports)
  }

  async getAll(): Promise<PendingReport[]> {
    if (!existsSync(this.statePath)) return []
    try {
      return JSON.parse(await fs.readFile(this.statePath, "utf-8")) as PendingReport[]
    } catch {
      return []
    }
  }

  async markProcessed(findingId: string, action: "sent" | "discarded"): Promise<void> {
    const reports = await this.getAll()
    const updated = reports.map((report) =>
      report.findingId === findingId ? { ...report, status: action } : report
    )
    await this.write(updated)
  }

  async size(): Promise<number> {
    return (await this.getAll()).filter((report) => report.status === "pending").length
  }

  private async write(reports: PendingReport[]): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true })
    await fs.writeFile(this.statePath, JSON.stringify(reports, null, 2), "utf-8")
  }
}
