import * as fs from "fs/promises"
import { existsSync } from "fs"
import { brainLogger } from "../logger/index.js"

// ── Interfaces ──────────────────────────────────────────────────

export interface ApprovedPushItem {
  itemId: string
  tentacleId: string
  content: string
  originalItems: string[]
  priority: "urgent" | "high" | "normal" | "low"
  timelinessHint: "immediate" | "today" | "this_week" | "anytime"
  needsUserAction: boolean
  approvedAt: string
  status: "pending" | "sent"
  sentAt?: string
}

// ── OutboundQueue ───────────────────────────────────────────────

export class OutboundQueue {
  constructor(private statePath: string) {}

  /**
   * Add an approved push item to the queue.
   */
  async addApprovedItem(item: ApprovedPushItem): Promise<void> {
    const items = await this.readAll()
    items.push(item)
    await this.write(items)

    brainLogger.info("outbound_queue_add", {
      item_id: item.itemId,
      tentacle_id: item.tentacleId,
      priority: item.priority,
      timeliness: item.timelinessHint,
    })
  }

  /**
   * Get all pending (unsent) items.
   */
  async getPending(): Promise<ApprovedPushItem[]> {
    const items = await this.readAll()
    return items.filter((i) => i.status === "pending")
  }

  /**
   * Get all items (including sent).
   */
  async getAll(): Promise<ApprovedPushItem[]> {
    return this.readAll()
  }

  /**
   * Mark an item as sent.
   */
  async markSent(itemId: string): Promise<void> {
    const items = await this.readAll()
    const item = items.find((i) => i.itemId === itemId)
    if (item) {
      item.status = "sent"
      item.sentAt = new Date().toISOString()
      await this.write(items)
    }
  }

  /**
   * Mark multiple items as sent.
   */
  async markSentBatch(itemIds: string[]): Promise<void> {
    const items = await this.readAll()
    const now = new Date().toISOString()
    for (const item of items) {
      if (itemIds.includes(item.itemId)) {
        item.status = "sent"
        item.sentAt = now
      }
    }
    await this.write(items)
  }

  /**
   * Count pending items.
   */
  async pendingCount(): Promise<number> {
    return (await this.getPending()).length
  }

  /**
   * Cleanup old sent items beyond retention period.
   */
  async cleanup(retentionDays: number = 7): Promise<number> {
    const items = await this.readAll()
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const kept = items.filter((i) => {
      if (i.status !== "sent") return true
      const sentAt = i.sentAt ? new Date(i.sentAt).getTime() : 0
      return sentAt > cutoff
    })
    const removed = items.length - kept.length
    if (removed > 0) {
      await this.write(kept)
      brainLogger.info("outbound_queue_cleanup", {
        removed,
        remaining: kept.length,
      })
    }
    return removed
  }

  // ── Private ───────────────────────────────────────────────────

  private async readAll(): Promise<ApprovedPushItem[]> {
    if (!existsSync(this.statePath)) return []
    try {
      const raw = await fs.readFile(this.statePath, "utf-8")
      return JSON.parse(raw) as ApprovedPushItem[]
    } catch {
      return []
    }
  }

  private async write(items: ApprovedPushItem[]): Promise<void> {
    await fs.writeFile(this.statePath, JSON.stringify(items, null, 2), "utf-8")
  }
}
