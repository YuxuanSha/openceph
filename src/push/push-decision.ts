import { brainLogger } from "../logger/index.js"
import type { OpenCephConfig } from "../config/config-schema.js"
import { OutboundQueue, type ApprovedPushItem } from "./outbound-queue.js"
import { DeduplicationEngine } from "./dedup-engine.js"
import type { MemoryManager } from "../memory/memory-manager.js"
import type { SessionStoreManager } from "../session/session-store.js"
import { PushDeliveryState } from "./push-delivery-state.js"
import * as os from "os"
import * as path from "path"

// ── Interfaces ──────────────────────────────────────────────────

export type PushTrigger =
  | { type: "user_message"; lastInteractionAt: string }
  | { type: "heartbeat" }
  | { type: "daily_review" }
  | { type: "urgent_report"; tentacleId: string }
  | { type: "action_confirm"; tentacleId: string }

export interface PushDecision {
  shouldPush: boolean
  reason: string
  items: ApprovedPushItem[]
  consolidatedText?: string
}

// Priority ordering for sorting
const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

// ── PushDecisionEngine ──────────────────────────────────────────

export class PushDecisionEngine {
  private dedup: DeduplicationEngine
  private deliveryState: PushDeliveryState

  constructor(
    private config: OpenCephConfig,
    private outboundQueue: OutboundQueue,
    private memoryManager?: MemoryManager,
    private sessionStore?: SessionStoreManager,
  ) {
    this.dedup = new DeduplicationEngine()
    this.deliveryState = new PushDeliveryState(resolveDeliveryStatePath(config, outboundQueue))
  }

  /**
   * Core method: evaluate whether to push now and which items to include.
   *
   * Logic:
   *   1. Get pending items from outbound queue
   *   2. If empty → don't push
   *   3. Dedup
   *   4. Decide based on trigger type and item properties:
   *      a. needsUserAction → always push
   *      b. urgent / immediate → always push
   *      c. user_message → piggyback all pending (natural timing)
   *      d. heartbeat/daily_review → push if ≥3 items or oldest > 24h
   *   5. Consolidate text, check daily limit
   */
  async evaluate(trigger: PushTrigger): Promise<PushDecision> {
    const pending = await this.outboundQueue.getPending()
    if (pending.length === 0) {
      return { shouldPush: false, reason: "queue_empty", items: [] }
    }

    // Dedup
    const pushConfig = this.config.push as any
    const dedupConfig = pushConfig?.dedup ?? {}
    const deduped = this.dedup.deduplicate(pending, {
      byUrl: dedupConfig.byUrl !== false,
      bySimilarity: dedupConfig.bySimilarity !== false,
      similarityThreshold: dedupConfig.similarityThreshold ?? 0.8,
    })

    if (deduped.length === 0) {
      return { shouldPush: false, reason: "all_duplicates", items: [] }
    }

    // Categorize items
    const actionRequired = deduped.filter((i) => i.needsUserAction)
    const urgent = deduped.filter(
      (i) => !i.needsUserAction && (i.priority === "urgent" || i.timelinessHint === "immediate"),
    )
    const normal = deduped.filter((i) => !i.needsUserAction && i.priority !== "urgent" && i.timelinessHint !== "immediate")

    // Rule a: items needing user action → always push
    if (actionRequired.length > 0) {
      const items = [...actionRequired, ...urgent]
      return this.buildDecision(items, "user_action_required", trigger)
    }

    // Rule b: urgent items → always push (bypass daily limit)
    if (urgent.length > 0 && (trigger.type === "urgent_report" || trigger.type === "action_confirm")) {
      return this.buildDecision(urgent, "urgent_report", trigger)
    }

    // Rule c: user just sent a message → piggyback all pending
    if (trigger.type === "user_message") {
      if (!(await this.isUserActive(trigger.lastInteractionAt))) {
        return { shouldPush: false, reason: "user_not_active_enough", items: [] }
      }
      return this.buildDecision(deduped, "user_message_piggyback", trigger)
    }

    // Rule d: heartbeat / daily_review → conditional push
    if (trigger.type === "heartbeat" || trigger.type === "daily_review") {
      // Check count threshold
      if (thematicGroups(deduped) >= 3 || deduped.length >= 3) {
        return this.buildDecision(deduped, "batch_threshold_reached", trigger)
      }

      // Check age: oldest pending > 24h
      const oldestAge = this.getOldestAge(deduped)
      if (oldestAge > 24 * 60 * 60 * 1000) {
        return this.buildDecision(deduped, "age_fallback_24h", trigger)
      }

      return { shouldPush: false, reason: "waiting_for_better_timing", items: [] }
    }

    // Urgent trigger with urgent items
    if (urgent.length > 0) {
      return this.buildDecision([...urgent, ...actionRequired], "urgent_report", trigger)
    }

    return { shouldPush: false, reason: "no_matching_rule", items: [] }
  }

  /**
   * Get today's push count (resets daily).
   */
  getDailyPushCount(): number {
    throw new Error("Use getDailyPushCountAsync() for persisted state")
  }

  async getDailyPushCountAsync(): Promise<number> {
    return (await this.deliveryState.read()).count
  }

  /**
   * Increment daily push counter after a successful push.
   */
  async recordPush(): Promise<void> {
    await this.deliveryState.increment()
  }

  // ── Private ───────────────────────────────────────────────────

  private async buildDecision(
    items: ApprovedPushItem[],
    reason: string,
    trigger: PushTrigger,
  ): Promise<PushDecision> {
    // Sort by priority
    const sorted = [...items].sort(
      (a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2),
    )

    // Check daily limit (urgent bypasses)
    const hasUrgent = sorted.some((i) => i.priority === "urgent")
    if (!hasUrgent) {
      const maxDaily = this.config.push?.maxDailyPushes ?? 3
      const dailyPushCount = await this.deliveryState.read()
      if (dailyPushCount.count >= maxDaily) {
        brainLogger.info("push_daily_limit_reached", {
          count: dailyPushCount.count,
          max: maxDaily,
        })
        return { shouldPush: false, reason: "daily_limit_reached", items: [] }
      }
    }

    // Consolidate text
    const consolidatedText = this.consolidate(sorted)

    brainLogger.info("push_decision", {
      should_push: true,
      reason,
      trigger_type: trigger.type,
      item_count: sorted.length,
      has_urgent: hasUrgent,
    })

    return {
      shouldPush: true,
      reason,
      items: sorted,
      consolidatedText,
    }
  }

  /**
   * Consolidate multiple push items into a single text block.
   * Groups by tentacle, sorted by priority.
   */
  private consolidate(items: ApprovedPushItem[]): string {
    if (items.length === 1) return items[0].content

    const shouldConsolidate = (this.config.push as any)?.consolidate !== false

    if (!shouldConsolidate) {
      return items.map((i) => i.content).join("\n\n---\n\n")
    }

    // Group by tentacle
    const groups = new Map<string, ApprovedPushItem[]>()
    for (const item of items) {
      const list = groups.get(item.tentacleId) ?? []
      list.push(item)
      groups.set(item.tentacleId, list)
    }

    const sections: string[] = []
    for (const [tentacleId, groupItems] of groups) {
      if (groupItems.length === 1) {
        sections.push(groupItems[0].content)
      } else {
        const header = `📋 ${tentacleId} (${groupItems.length} items)`
        const body = groupItems
          .map((i, idx) => `${idx + 1}. ${i.content}`)
          .join("\n")
        sections.push(`${header}\n${body}`)
      }
    }

    return sections.join("\n\n---\n\n")
  }

  private getOldestAge(items: ApprovedPushItem[]): number {
    let oldest = Date.now()
    for (const item of items) {
      const t = new Date(item.approvedAt).getTime()
      if (t < oldest) oldest = t
    }
    return Date.now() - oldest
  }

  private async isUserActive(lastInteractionAt: string): Promise<boolean> {
    const ageMs = Date.now() - new Date(lastInteractionAt).getTime()
    if (ageMs <= 30 * 60 * 1000) return true

    if (this.memoryManager) {
      try {
        const memory = await this.memoryManager.readMemory(undefined, "push")
        if (/do not disturb|busy|don't disturb|stop notifications|quiet hours|fewer pushes/i.test(memory)) return false
      } catch {
        // ignore memory read failure
      }
    }
    return ageMs <= 8 * 60 * 60 * 1000
  }
}

function thematicGroups(items: ApprovedPushItem[]): number {
  return new Set(items.map((item) => item.tentacleId)).size
}

function resolveDeliveryStatePath(config: OpenCephConfig, outboundQueue: OutboundQueue): string {
  const configured = (config.push as any)?.deliveryStatePath
  if (typeof configured === "string" && configured.trim()) return configured

  const queuePath = (outboundQueue as any)?.queuePath
  if (typeof queuePath === "string" && queuePath.trim()) {
    return path.join(path.dirname(queuePath), "push-delivery.json")
  }

  if (process.env.VITEST === "true") {
    return path.join(os.tmpdir(), `openceph-push-delivery-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  }

  return path.join(os.homedir(), ".openceph", "state", "push-delivery.json")
}
