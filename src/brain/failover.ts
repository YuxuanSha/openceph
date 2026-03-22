import { brainLogger } from "../logger/index.js"
import type { OpenCephConfig } from "../config/config-schema.js"

// ── Interfaces ──────────────────────────────────────────────────

export interface FailoverDecision {
  action: "ok" | "switch" | "emergency_compact"
  reason: string
  suggestedModel?: string
}

// Known context limits per model family (conservative estimates)
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "anthropic/claude-sonnet-4-5": 200_000,
  "anthropic/claude-haiku-4-5": 200_000,
  "anthropic/claude-opus-4-5": 200_000,
  "openai/gpt-4o": 128_000,
  "openai/gpt-4o-mini": 128_000,
  "google/gemini-2.0-flash": 1_000_000,
  "google/gemini-2.5-pro": 1_000_000,
}

const CONTEXT_WARNING_RATIO = 0.85
const CONTEXT_CRITICAL_RATIO = 0.95

// ── ModelFailover ───────────────────────────────────────────────

export class ModelFailover {
  constructor(private config: OpenCephConfig) {}

  /**
   * Check if current token usage is approaching context limit.
   * Returns a decision on whether to switch models or compact.
   */
  checkContextLimit(currentTokens: number, model: string): FailoverDecision {
    const limit = this.getContextLimit(model)

    const ratio = currentTokens / limit

    if (ratio < CONTEXT_WARNING_RATIO) {
      return { action: "ok", reason: "within_limits" }
    }

    if (ratio >= CONTEXT_CRITICAL_RATIO) {
      // Try fallback first
      const fallback = this.switchToFallback(model)
      if (fallback) {
        const fallbackLimit = this.getContextLimit(fallback)
        if (currentTokens / fallbackLimit < CONTEXT_WARNING_RATIO) {
          brainLogger.info("model_failover", {
            from: model,
            to: fallback,
            reason: "context_critical",
            current_tokens: currentTokens,
            limit,
            ratio: ratio.toFixed(3),
          })
          return {
            action: "switch",
            reason: `Context at ${(ratio * 100).toFixed(0)}% — switching to ${fallback}`,
            suggestedModel: fallback,
          }
        }
      }

      // No fallback has more capacity — emergency compact
      brainLogger.warn("model_failover_emergency", {
        model,
        current_tokens: currentTokens,
        limit,
        ratio: ratio.toFixed(3),
      })
      return {
        action: "emergency_compact",
        reason: `Context at ${(ratio * 100).toFixed(0)}% — no fallback with more capacity, need compaction`,
      }
    }

    // Warning zone — log but take no action
    brainLogger.info("context_warning", {
      model,
      current_tokens: currentTokens,
      limit,
      ratio: ratio.toFixed(3),
    })
    return {
      action: "ok",
      reason: `Context at ${(ratio * 100).toFixed(0)}% — approaching limit`,
    }
  }

  /**
   * Get the next fallback model from the config.
   * Returns null if no fallback available or already on last fallback.
   */
  switchToFallback(currentModel: string): string | null {
    const primary = this.config.agents.defaults.model.primary
    const fallbacks = this.config.agents.defaults.model.fallbacks

    const allModels = [primary, ...fallbacks]
    const currentIndex = allModels.indexOf(currentModel)

    // If not in the list, try first fallback
    if (currentIndex === -1) {
      return fallbacks.length > 0 ? fallbacks[0] : null
    }

    // Try next in the list
    if (currentIndex + 1 < allModels.length) {
      return allModels[currentIndex + 1]
    }

    return null
  }

  /**
   * Get context limit for a model (tokens).
   */
  getContextLimit(model: string): number {
    return MODEL_CONTEXT_LIMITS[model] ?? 128_000
  }
}
