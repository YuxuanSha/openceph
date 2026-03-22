import * as fs from "fs/promises"
import { existsSync } from "fs"
import { brainLogger } from "../logger/index.js"
import * as path from "path"

// ── Interfaces ──────────────────────────────────────────────────

export interface ApprovedPushItem {
  kind?: "approved_push"
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

export interface DeferredMessage {
  kind: "deferred_message"
  messageId: string
  message: string
  channel: string
  senderId: string
  timing: "best_time" | "morning_digest"
  priority: "urgent" | "normal" | "low"
  source: "main_session" | "consultation_session"
  sourceSessionKey?: string
  targetSessionKey?: string
  tentacleId?: string
  createdAt: string
  status: "pending" | "sent"
  deliveredAt?: string
}

type QueueEntry = ApprovedPushItem | DeferredMessage

// ── OutboundQueue ───────────────────────────────────────────────

export class OutboundQueue {
  constructor(private statePath: string) {}

  get queuePath(): string {
    return this.statePath
  }

  /**
   * Add an approved push item to the queue.
   */
  async addApprovedItem(item: ApprovedPushItem): Promise<void> {
    const items = await this.readAllEntries()
    items.push(item)
    await this.write(items)

    brainLogger.info("outbound_queue_add", {
      item_id: item.itemId,
      tentacle_id: item.tentacleId,
      priority: item.priority,
      timeliness: item.timelinessHint,
    })
  }

  async addDeferredMessage(item: Omit<DeferredMessage, "kind" | "createdAt" | "status"> & {
    createdAt?: string
    status?: DeferredMessage["status"]
  }): Promise<void> {
    const items = await this.readAllEntries()
    items.push({
      kind: "deferred_message",
      createdAt: item.createdAt ?? new Date().toISOString(),
      status: item.status ?? "pending",
      ...item,
    })
    await this.write(items)

    brainLogger.info("deferred_message_add", {
      message_id: item.messageId,
      source: item.source,
      timing: item.timing,
      channel: item.channel,
    })
  }

  /**
   * Get all pending (unsent) items.
   */
  async getPending(): Promise<ApprovedPushItem[]> {
    return (await this.readAllEntries())
      .filter((i): i is ApprovedPushItem => !("kind" in i) || i.kind !== "deferred_message")
      .filter((i) => i.status === "pending")
  }

  async getPendingDeferred(): Promise<DeferredMessage[]> {
    return (await this.readAllEntries())
      .filter((i): i is DeferredMessage => "kind" in i && i.kind === "deferred_message")
      .filter((i) => i.status === "pending")
  }

  /**
   * Get all items (including sent).
   */
  async getAll(): Promise<ApprovedPushItem[]> {
    return (await this.readAllEntries()).filter(
      (i): i is ApprovedPushItem => !("kind" in i) || i.kind !== "deferred_message",
    )
  }

  /**
   * Mark an item as sent.
   */
  async markSent(itemId: string): Promise<void> {
    const items = await this.readAllEntries()
    const item = items.find((i) => !("kind" in i) || i.kind !== "deferred_message" ? i.itemId === itemId : false)
    if (item && (!("kind" in item) || item.kind !== "deferred_message")) {
      item.status = "sent"
      item.sentAt = new Date().toISOString()
      await this.write(items)
    }
  }

  /**
   * Mark multiple items as sent.
   */
  async markSentBatch(itemIds: string[]): Promise<void> {
    const items = await this.readAllEntries()
    const now = new Date().toISOString()
    for (const item of items) {
      if ((!("kind" in item) || item.kind !== "deferred_message") && itemIds.includes(item.itemId)) {
        item.status = "sent"
        item.sentAt = now
      }
    }
    await this.write(items)
  }

  async markDeferredSent(messageIds: string[]): Promise<void> {
    const items = await this.readAllEntries()
    const now = new Date().toISOString()
    for (const item of items) {
      if ("kind" in item && item.kind === "deferred_message" && messageIds.includes(item.messageId)) {
        item.status = "sent"
        item.deliveredAt = now
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
    const items = await this.readAllEntries()
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const kept = items.filter((i) => {
      if (i.status !== "sent") return true
      const sentAt = "kind" in i && i.kind === "deferred_message"
        ? (i.deliveredAt ? new Date(i.deliveredAt).getTime() : 0)
        : (i.sentAt ? new Date(i.sentAt).getTime() : 0)
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

  private async readAllEntries(): Promise<QueueEntry[]> {
    if (!existsSync(this.statePath)) return []
    try {
      const raw = await fs.readFile(this.statePath, "utf-8")
      const parsed = JSON.parse(raw) as QueueEntry[]
      return parsed.map((entry) => {
        if ((entry as DeferredMessage).kind === "deferred_message") {
          return entry
        }
        return {
          kind: "approved_push",
          ...(entry as ApprovedPushItem),
        }
      })
    } catch {
      return []
    }
  }

  private async write(items: QueueEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true })
    const normalized = items.map((entry) => {
      if ("kind" in entry && entry.kind === "deferred_message") return entry
      const { kind, ...rest } = entry as ApprovedPushItem & { kind?: string }
      return rest
    })
    await fs.writeFile(this.statePath, JSON.stringify(normalized, null, 2), "utf-8")
  }
}
