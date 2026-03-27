import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

export interface CostEntry {
  timestamp: string
  tentacleId: string
  requestId: string
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

/** Per-model pricing (USD per 1M tokens) */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "google/gemini-2.5-flash-preview": { input: 0.15, output: 0.60 },
  "google/gemini-2.0-flash": { input: 0.10, output: 0.40 },
  "google/gemini-2.5-pro-preview": { input: 1.25, output: 10.00 },
  "anthropic/claude-sonnet-4": { input: 3.00, output: 15.00 },
  "anthropic/claude-haiku-4": { input: 0.80, output: 4.00 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.60 },
}

/**
 * Tracks LLM call costs per tentacle.
 * Appends entries to a JSONL log file for later analysis.
 */
export class CostTracker {
  private logPath: string
  private totals: Map<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> = new Map()

  constructor(logDir?: string) {
    const dir = logDir ?? path.join(os.homedir(), ".openceph", "logs")
    this.logPath = path.join(dir, "llm-gateway-cost.jsonl")
  }

  async log(entry: Omit<CostEntry, "timestamp">): Promise<void> {
    const full: CostEntry = { ...entry, timestamp: new Date().toISOString() }

    // Update in-memory totals
    const existing = this.totals.get(entry.tentacleId) ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    existing.calls++
    existing.inputTokens += entry.inputTokens
    existing.outputTokens += entry.outputTokens
    existing.costUsd += entry.costUsd
    this.totals.set(entry.tentacleId, existing)

    // Append to log file (non-blocking, fire-and-forget)
    try {
      await fs.mkdir(path.dirname(this.logPath), { recursive: true })
      await fs.appendFile(this.logPath, JSON.stringify(full) + "\n")
    } catch {
      // Silently ignore write errors — cost tracking is best-effort
    }
  }

  calculateCost(model: string, usage: { prompt_tokens?: number; completion_tokens?: number }): number {
    const inputTokens = usage.prompt_tokens ?? 0
    const outputTokens = usage.completion_tokens ?? 0

    // Try exact match first, then strip provider prefix
    let pricing = MODEL_PRICING[model]
    if (!pricing) {
      const shortModel = model.includes("/") ? model.split("/").slice(1).join("/") : model
      pricing = MODEL_PRICING[shortModel]
    }
    if (!pricing) {
      // Default fallback pricing
      pricing = { input: 0.50, output: 1.50 }
    }

    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
  }

  getTotals(): Map<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> {
    return new Map(this.totals)
  }

  getTentacleCost(tentacleId: string): number {
    return this.totals.get(tentacleId)?.costUsd ?? 0
  }
}
