import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import { brainLogger } from "../logger/index.js"
import type { TentacleHealthCalculator } from "../tentacle/health-score.js"

// ── Interfaces ──────────────────────────────────────────────────

export interface PushFeedback {
  messageId: string
  sourceTentacles: string[]
  reaction: "positive" | "negative" | "ignored"
  timestamp: string
}

interface FeedbackStore {
  feedbacks: PushFeedback[]
}

// ── PushFeedbackTracker ─────────────────────────────────────────

export class PushFeedbackTracker {
  private storePath: string

  constructor(
    private memoryDir: string,
    private healthCalculator: TentacleHealthCalculator | null,
  ) {
    this.storePath = path.join(memoryDir, "push-feedback.json")
  }

  /**
   * Record push feedback and update per-tentacle feedback files.
   */
  async recordFeedback(feedback: PushFeedback): Promise<void> {
    // 1. Save to central store
    const store = await this.readStore()
    store.feedbacks.push(feedback)
    // Keep last 500 entries
    if (store.feedbacks.length > 500) {
      store.feedbacks = store.feedbacks.slice(-500)
    }
    await this.writeStore(store)

    // 2. Update per-tentacle feedback.json files
    for (const tentacleId of feedback.sourceTentacles) {
      await this.updateTentacleFeedback(tentacleId, feedback.reaction)
    }

    brainLogger.info("push_feedback_recorded", {
      message_id: feedback.messageId,
      reaction: feedback.reaction,
      tentacles: feedback.sourceTentacles.join(", "),
    })
  }

  /**
   * Get adoption rate for a specific tentacle over the given number of days.
   */
  async getAdoptionRate(tentacleId: string, days: number = 30): Promise<number> {
    const store = await this.readStore()
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

    const relevant = store.feedbacks.filter(
      (f) =>
        f.sourceTentacles.includes(tentacleId) &&
        new Date(f.timestamp).getTime() > cutoff,
    )

    if (relevant.length === 0) return 0.5 // Neutral default

    const positive = relevant.filter((f) => f.reaction === "positive").length
    return positive / relevant.length
  }

  /**
   * Get overall stats.
   */
  async getStats(days: number = 7): Promise<{
    total: number
    positive: number
    negative: number
    ignored: number
  }> {
    const store = await this.readStore()
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const recent = store.feedbacks.filter(
      (f) => new Date(f.timestamp).getTime() > cutoff,
    )

    return {
      total: recent.length,
      positive: recent.filter((f) => f.reaction === "positive").length,
      negative: recent.filter((f) => f.reaction === "negative").length,
      ignored: recent.filter((f) => f.reaction === "ignored").length,
    }
  }

  // ── Private ───────────────────────────────────────────────────

  /**
   * Update the tentacle's feedback.json file (used by HealthCalculator).
   */
  private async updateTentacleFeedback(
    tentacleId: string,
    reaction: PushFeedback["reaction"],
  ): Promise<void> {
    // Find tentacle dir via health calculator's manager or construct path
    const feedbackPath = path.join(this.memoryDir, "..", "tentacles", tentacleId, "feedback.json")
    let data = { positive: 0, negative: 0, ignored: 0 }

    if (existsSync(feedbackPath)) {
      try {
        data = JSON.parse(await fs.readFile(feedbackPath, "utf-8"))
      } catch {
        // Reset on corrupt file
      }
    }

    data[reaction]++

    try {
      const dir = path.dirname(feedbackPath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(feedbackPath, JSON.stringify(data, null, 2), "utf-8")
    } catch {
      // Non-critical — log but don't throw
    }
  }

  private async readStore(): Promise<FeedbackStore> {
    if (!existsSync(this.storePath)) {
      return { feedbacks: [] }
    }
    try {
      return JSON.parse(await fs.readFile(this.storePath, "utf-8")) as FeedbackStore
    } catch {
      return { feedbacks: [] }
    }
  }

  private async writeStore(store: FeedbackStore): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true })
    await fs.writeFile(this.storePath, JSON.stringify(store, null, 2), "utf-8")
  }
}

// ── Feedback Signal Detection ───────────────────────────────────

/**
 * Detect user reaction from message text.
 * Returns null if no clear signal.
 */
export function detectFeedbackSignal(text: string): "positive" | "negative" | null {
  const lower = text.toLowerCase()

  const positivePatterns = [
    "有用", "好的", "收到", "谢谢", "不错", "很好", "挺好",
    "thanks", "useful", "great", "good", "helpful", "nice",
    "👍", "🙏", "❤️",
  ]
  const negativePatterns = [
    "没用", "不要再发", "停止", "别发了", "太多了", "不需要",
    "useless", "stop", "don't send", "not useful", "annoying",
    "👎",
  ]

  for (const p of negativePatterns) {
    if (lower.includes(p)) return "negative"
  }
  for (const p of positivePatterns) {
    if (lower.includes(p)) return "positive"
  }

  return null
}
