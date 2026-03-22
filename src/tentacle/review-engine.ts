import { brainLogger } from "../logger/index.js"
import type { TentacleManager, TentacleStatus } from "./manager.js"
import type { TentacleHealthCalculator, HealthScore } from "./health-score.js"
import type { MemoryManager } from "../memory/memory-manager.js"
import type { OutboundQueue } from "../push/outbound-queue.js"

// ── Interfaces ──────────────────────────────────────────────────

export interface ReviewAction {
  tentacleId: string
  action: "weaken" | "kill" | "merge" | "strengthen" | "none"
  reason: string
  confidence: number
  mergeWith?: string
  requiresUserConfirm: boolean
}

// ── TentacleReviewEngine ────────────────────────────────────────

export class TentacleReviewEngine {
  constructor(
    private tentacleManager: TentacleManager,
    private healthCalculator: TentacleHealthCalculator,
    private memoryManager?: MemoryManager,
    private outboundQueue?: OutboundQueue,
  ) {}

  /**
   * Review all active tentacles and produce a list of recommended actions.
   * Rules:
   *   healthScore < 0.2 && status=running         → weaken (no confirm)
   *   status=weakened && healthScore < 0.1         → kill (confirm)
   *   14 days with 0 reports                       → kill (confirm)
   *   two tentacles with purpose similarity > 0.6  → merge (confirm)
   *   healthScore > 0.8 && status=weakened         → strengthen (no confirm)
   */
  async review(): Promise<ReviewAction[]> {
    const actions: ReviewAction[] = []
    const allTentacles = this.tentacleManager.listAll()
    const activeTentacles = allTentacles.filter(
      (t) => t.status !== "killed" && t.status !== "crashed",
    )

    if (activeTentacles.length === 0) return actions

    // Calculate health for all active tentacles
    const healthMap = await this.healthCalculator.calculateAll()
    const memorySnapshot = this.memoryManager ? await this.memoryManager.readMemory() : ""
    const pendingPushByTentacle = await this.loadPendingPushCounts()

    // Per-tentacle rules
    for (const tentacle of activeTentacles) {
      const health = healthMap.get(tentacle.tentacleId)
      if (!health) continue

      const action = this.evaluateSingle(
        tentacle,
        health,
        {
          userFocusHigh: this.hasStrongUserFocus(tentacle, memorySnapshot),
          pendingPushCount: pendingPushByTentacle.get(tentacle.tentacleId) ?? 0,
        },
      )
      if (action) actions.push(action)
    }

    // Cross-tentacle rules: merge candidates
    const mergeCandidates = this.findMergeCandidates(activeTentacles)
    for (const candidate of mergeCandidates) {
      // Skip if either tentacle already has a pending action
      const hasAction = actions.some(
        (a) =>
          (a.tentacleId === candidate.a || a.tentacleId === candidate.b) &&
          a.action !== "none",
      )
      if (hasAction) continue

      actions.push({
        tentacleId: candidate.a,
        action: "merge",
        reason: `Purpose overlap with ${candidate.b} (similarity: ${candidate.similarity.toFixed(2)})`,
        confidence: candidate.similarity,
        mergeWith: candidate.b,
        requiresUserConfirm: true,
      })
    }

    brainLogger.info("tentacle_review_complete", {
      total_reviewed: activeTentacles.length,
      actions_count: actions.filter((a) => a.action !== "none").length,
      actions_summary: actions
        .filter((a) => a.action !== "none")
        .map((a) => `${a.tentacleId}:${a.action}`)
        .join(", "),
    })

    return actions
  }

  // ── Private ───────────────────────────────────────────────────

  private evaluateSingle(
    tentacle: TentacleStatus,
    health: HealthScore,
    context: { userFocusHigh: boolean; pendingPushCount: number },
  ): ReviewAction | null {
    const { tentacleId, status, lastReportAt } = tentacle
    const { score } = health

    // Rule: weakened + healthScore < 0.1 → kill (confirm)
    if (status === "weakened" && score < 0.1) {
      return {
        tentacleId,
        action: "kill",
        reason: `Health score ${score.toFixed(2)} remains critically low after weakening`,
        confidence: 0.9,
        requiresUserConfirm: true,
      }
    }

    // Rule: 14 days with 0 reports → kill (confirm)
    if (lastReportAt) {
      const daysSinceReport = (Date.now() - new Date(lastReportAt).getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceReport >= 14) {
        return {
          tentacleId,
          action: "kill",
          reason: `No reports for ${Math.floor(daysSinceReport)} days`,
          confidence: 0.85,
          requiresUserConfirm: true,
        }
      }
    } else if (tentacle.createdAt) {
      // Never reported — check age
      const daysSinceCreation = (Date.now() - new Date(tentacle.createdAt).getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceCreation >= 14) {
        return {
          tentacleId,
          action: "kill",
          reason: `Never reported since creation ${Math.floor(daysSinceCreation)} days ago`,
          confidence: 0.8,
          requiresUserConfirm: true,
        }
      }
    }

    // Rule: healthScore > 0.8 && status=weakened → strengthen (no confirm)
    if (status === "weakened" && score > 0.8) {
      return {
        tentacleId,
        action: "strengthen",
        reason: `Health score recovered to ${score.toFixed(2)} — restore frequency`,
        confidence: 0.85,
        requiresUserConfirm: false,
      }
    }

    if ((status === "running" || status === "weakened") && context.userFocusHigh) {
      return {
        tentacleId,
        action: "strengthen",
        reason: `User memory recently emphasizes this domain and ${context.pendingPushCount} pending push item(s) are queued`,
        confidence: context.pendingPushCount > 0 ? 0.88 : 0.75,
        requiresUserConfirm: false,
      }
    }

    // Rule: healthScore < 0.2 && status=running → weaken (no confirm)
    if (status === "running" && score < 0.2) {
      return {
        tentacleId,
        action: "weaken",
        reason: `Health score ${score.toFixed(2)} is below threshold`,
        confidence: 0.8,
        requiresUserConfirm: false,
      }
    }

    return null
  }

  private hasStrongUserFocus(tentacle: TentacleStatus, memorySnapshot: string): boolean {
    if (!tentacle.purpose || !memorySnapshot) return false
    const purposeTokens = tokenize(tentacle.purpose).filter((token) => token.length >= 3)
    if (purposeTokens.length === 0) return false
    const lowerMemory = memorySnapshot.toLowerCase()
    const matched = purposeTokens.filter((token) => lowerMemory.includes(token)).length
    return matched >= Math.min(2, purposeTokens.length)
  }

  private async loadPendingPushCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    if (!this.outboundQueue) return counts
    const pending = await this.outboundQueue.getPending()
    for (const item of pending) {
      counts.set(item.tentacleId, (counts.get(item.tentacleId) ?? 0) + 1)
    }
    return counts
  }

  /**
   * Find pairs of tentacles with similar purposes (cosine-like similarity
   * using simple word overlap / Jaccard coefficient).
   */
  private findMergeCandidates(
    tentacles: TentacleStatus[],
  ): { a: string; b: string; similarity: number }[] {
    const candidates: { a: string; b: string; similarity: number }[] = []

    for (let i = 0; i < tentacles.length; i++) {
      for (let j = i + 1; j < tentacles.length; j++) {
        const a = tentacles[i]
        const b = tentacles[j]
        if (!a.purpose || !b.purpose) continue

        const similarity = jaccardSimilarity(a.purpose, b.purpose)
        if (similarity > 0.6) {
          candidates.push({
            a: a.tentacleId,
            b: b.tentacleId,
            similarity,
          })
        }
      }
    }

    // Sort by highest similarity first
    candidates.sort((a, b) => b.similarity - a.similarity)
    return candidates
  }
}

/**
 * Jaccard similarity on word sets (lowercased, non-empty tokens).
 */
function jaccardSimilarity(textA: string, textB: string): number {
  const wordsA = new Set(tokenize(textA))
  const wordsB = new Set(tokenize(textB))
  if (wordsA.size === 0 && wordsB.size === 0) return 0

  let intersection = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++
  }
  const union = wordsA.size + wordsB.size - intersection
  return union === 0 ? 0 : intersection / union
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
}
