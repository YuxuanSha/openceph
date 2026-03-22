import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import type { TentacleManager } from "./manager.js"
import type { PendingReportsQueue } from "./pending-reports.js"

export interface HealthScore {
  score: number              // 0.0 - 1.0
  components: {
    reportFrequency: number  // Recent 7-day report count (normalized)
    avgQuality: number       // Brain adoption ratio in consultations
    adoptionRate: number     // User positive feedback ratio
  }
  trend: "improving" | "stable" | "declining"
  lastCalculatedAt: string
}

interface HealthHistory {
  tentacleId: string
  scores: { score: number; at: string }[]
}

export class TentacleHealthCalculator {
  private historyDir: string

  constructor(
    private tentacleManager: TentacleManager,
    private pendingReports: PendingReportsQueue,
  ) {
    this.historyDir = path.join(tentacleManager.getTentacleBaseDir(), ".health")
  }

  async calculate(tentacleId: string): Promise<HealthScore> {
    const status = this.tentacleManager.getStatus(tentacleId)
    if (!status) {
      return emptyScore()
    }

    const reportFrequency = this.calcReportFrequency(status.totalReports, status.lastReportAt)
    const avgQuality = await this.calcAvgQuality(tentacleId)
    const adoptionRate = await this.calcAdoptionRate(tentacleId)

    // Weighted score: 40% frequency, 35% quality, 25% adoption
    const score = clamp(
      reportFrequency * 0.4 + avgQuality * 0.35 + adoptionRate * 0.25,
    )

    const trend = await this.calcTrend(tentacleId, score)

    const healthScore: HealthScore = {
      score,
      components: { reportFrequency, avgQuality, adoptionRate },
      trend,
      lastCalculatedAt: new Date().toISOString(),
    }

    await this.saveHistory(tentacleId, score)
    return healthScore
  }

  async calculateAll(): Promise<Map<string, HealthScore>> {
    const result = new Map<string, HealthScore>()
    const tentacles = this.tentacleManager.listAll()
    for (const t of tentacles) {
      if (t.status === "killed") continue
      result.set(t.tentacleId, await this.calculate(t.tentacleId))
    }
    return result
  }

  // ── Private calculations ─────────────────────────────────────

  /**
   * Report frequency: normalized based on 7-day expected reports.
   * If a tentacle reports at least once a day, score = 1.0.
   * Scale: 0 reports in 7d = 0, 7+ reports in 7d = 1.0
   */
  private calcReportFrequency(totalReports: number, lastReportAt?: string): number {
    if (!lastReportAt) return 0

    const lastReport = new Date(lastReportAt).getTime()
    const now = Date.now()
    const daysSinceLastReport = (now - lastReport) / (1000 * 60 * 60 * 24)

    // Heavily penalize if no report in 7+ days
    if (daysSinceLastReport > 14) return 0
    if (daysSinceLastReport > 7) return 0.1

    // Use total reports as a proxy (normalized to 7 reports = 1.0)
    const recentEstimate = Math.min(totalReports, 7)
    const frequencyScore = recentEstimate / 7

    // Decay based on recency
    const recencyDecay = Math.max(0, 1 - daysSinceLastReport / 7)

    return clamp(frequencyScore * 0.6 + recencyDecay * 0.4)
  }

  /**
   * Average quality: ratio of reports that were acted upon vs total.
   * Without detailed consultation tracking, we use a heuristic:
   * reports that were sent (vs discarded) from PendingReportsQueue.
   */
  private async calcAvgQuality(tentacleId: string): Promise<number> {
    const allReports = await this.pendingReports.getAll()
    const tentacleReports = allReports.filter((r) => r.tentacleId === tentacleId)
    if (tentacleReports.length === 0) return 0.5 // Default neutral

    const sent = tentacleReports.filter((r) => r.status === "sent").length
    const total = tentacleReports.length
    return clamp(sent / total)
  }

  /**
   * Adoption rate: user positive feedback ratio.
   * Read from memory/feedback files if available; default to neutral.
   */
  private async calcAdoptionRate(tentacleId: string): Promise<number> {
    try {
      const feedbackPath = path.join(
        this.tentacleManager.getTentacleDir(tentacleId),
        "feedback.json",
      )
      if (!existsSync(feedbackPath)) return 0.5

      const data = JSON.parse(await fs.readFile(feedbackPath, "utf-8")) as {
        positive: number
        negative: number
        ignored: number
      }
      const total = data.positive + data.negative + data.ignored
      if (total === 0) return 0.5
      return clamp(data.positive / total)
    } catch {
      return 0.5 // Neutral default
    }
  }

  /**
   * Trend: compare current score to average of last 3 saved scores.
   */
  private async calcTrend(tentacleId: string, currentScore: number): Promise<HealthScore["trend"]> {
    const history = await this.loadHistory(tentacleId)
    if (history.scores.length < 2) return "stable"

    const recent = history.scores.slice(-3)
    const avgRecent = recent.reduce((sum, s) => sum + s.score, 0) / recent.length
    const diff = currentScore - avgRecent

    if (diff > 0.1) return "improving"
    if (diff < -0.1) return "declining"
    return "stable"
  }

  // ── Persistence ──────────────────────────────────────────────

  private async loadHistory(tentacleId: string): Promise<HealthHistory> {
    const filePath = path.join(this.historyDir, `${tentacleId}.json`)
    if (!existsSync(filePath)) {
      return { tentacleId, scores: [] }
    }
    try {
      return JSON.parse(await fs.readFile(filePath, "utf-8")) as HealthHistory
    } catch {
      return { tentacleId, scores: [] }
    }
  }

  private async saveHistory(tentacleId: string, score: number): Promise<void> {
    await fs.mkdir(this.historyDir, { recursive: true })
    const history = await this.loadHistory(tentacleId)
    history.scores.push({ score, at: new Date().toISOString() })
    // Keep last 30 entries
    if (history.scores.length > 30) {
      history.scores = history.scores.slice(-30)
    }
    const filePath = path.join(this.historyDir, `${tentacleId}.json`)
    await fs.writeFile(filePath, JSON.stringify(history, null, 2), "utf-8")
  }
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function emptyScore(): HealthScore {
  return {
    score: 0,
    components: { reportFrequency: 0, avgQuality: 0, adoptionRate: 0 },
    trend: "stable",
    lastCalculatedAt: new Date().toISOString(),
  }
}
