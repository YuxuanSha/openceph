import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import { brainLogger } from "../logger/index.js"

export interface PendingReport {
  findingId: string
  tentacleId: string
  summary: string
  confidence: number
  createdAt: string
  status: "pending" | "sent" | "discarded"
}

export class PendingReportsQueue {
  constructor(
    private statePath: string,
    private maxPending: number = 20,
  ) {}

  async add(report: PendingReport): Promise<void> {
    const reports = await this.getAll()
    reports.push(report)
    const pending = reports.filter((item) => item.status === "pending")
    if (pending.length > this.maxPending) {
      const overflow = pending.length - this.maxPending
      let remainingOverflow = overflow
      for (const item of reports) {
        if (remainingOverflow === 0) break
        if (item.status === "pending") {
          item.status = "discarded"
          remainingOverflow--
          try {
            brainLogger.warn("tentacle_report_discarded", {
              tentacle_id: item.tentacleId,
              finding_id: item.findingId,
              reason: "pending_queue_overflow",
            })
          } catch {
            // Queue overflow handling must still work in isolated test/runtime contexts
            // where the global logger has not been initialized yet.
          }
        }
      }
    }
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
