import type { ApprovedPushItem } from "./outbound-queue.js"

// ── DeduplicationEngine ─────────────────────────────────────────

export class DeduplicationEngine {
  /**
   * Remove items with duplicate source URLs.
   * Keeps the higher-priority / earlier-approved item.
   */
  deduplicateByUrl(items: ApprovedPushItem[]): ApprovedPushItem[] {
    const seen = new Map<string, ApprovedPushItem>()
    const result: ApprovedPushItem[] = []

    for (const item of items) {
      const urls = extractUrls(item.content)
      let isDup = false

      for (const url of urls) {
        const normalized = normalizeUrl(url)
        if (seen.has(normalized)) {
          isDup = true
          break
        }
        seen.set(normalized, item)
      }

      if (!isDup || urls.length === 0) {
        result.push(item)
      }
    }

    return result
  }

  /**
   * Remove items with similar content (trigram Jaccard coefficient).
   * Keeps the higher-priority / earlier-approved item.
   */
  deduplicateBySimilarity(items: ApprovedPushItem[], threshold: number = 0.8): ApprovedPushItem[] {
    const result: ApprovedPushItem[] = []

    for (const item of items) {
      let isDup = false
      for (const existing of result) {
        const sim = trigramJaccard(item.content, existing.content)
        if (sim >= threshold) {
          isDup = true
          break
        }
      }
      if (!isDup) {
        result.push(item)
      }
    }

    return result
  }

  /**
   * Run both dedup passes.
   */
  deduplicate(
    items: ApprovedPushItem[],
    options: { byUrl?: boolean; bySimilarity?: boolean; similarityThreshold?: number } = {},
  ): ApprovedPushItem[] {
    let result = items
    if (options.byUrl !== false) {
      result = this.deduplicateByUrl(result)
    }
    if (options.bySimilarity !== false) {
      result = this.deduplicateBySimilarity(result, options.similarityThreshold ?? 0.8)
    }
    return result
  }
}

// ── Trigram Jaccard ─────────────────────────────────────────────

function trigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim()
  const grams = new Set<string>()
  for (let i = 0; i <= normalized.length - 3; i++) {
    grams.add(normalized.substring(i, i + 3))
  }
  return grams
}

export function trigramJaccard(a: string, b: string): number {
  const gramsA = trigrams(a)
  const gramsB = trigrams(b)
  if (gramsA.size === 0 && gramsB.size === 0) return 1

  let intersection = 0
  for (const g of gramsA) {
    if (gramsB.has(g)) intersection++
  }
  const union = gramsA.size + gramsB.size - intersection
  return union === 0 ? 0 : intersection / union
}

// ── URL extraction ──────────────────────────────────────────────

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>\"']+/g
  return Array.from(text.matchAll(urlRegex), (m) => m[0])
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    // Remove tracking params
    u.searchParams.delete("utm_source")
    u.searchParams.delete("utm_medium")
    u.searchParams.delete("utm_campaign")
    u.searchParams.delete("utm_content")
    u.searchParams.delete("utm_term")
    u.searchParams.delete("ref")
    // Remove trailing slash
    u.pathname = u.pathname.replace(/\/+$/, "") || "/"
    return u.toString()
  } catch {
    return url.toLowerCase()
  }
}
