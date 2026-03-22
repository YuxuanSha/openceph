import { describe, it, expect } from "vitest"
import { DeduplicationEngine, trigramJaccard } from "../../src/push/dedup-engine.js"
import type { ApprovedPushItem } from "../../src/push/outbound-queue.js"

function makeItem(overrides: Partial<ApprovedPushItem> = {}): ApprovedPushItem {
  return {
    itemId: `item_${Math.random().toString(36).slice(2)}`,
    tentacleId: "t_test",
    content: "Default test content",
    originalItems: [],
    priority: "normal",
    timelinessHint: "today",
    needsUserAction: false,
    approvedAt: new Date().toISOString(),
    status: "pending",
    ...overrides,
  }
}

describe("DeduplicationEngine", () => {
  const dedup = new DeduplicationEngine()

  describe("deduplicateByUrl", () => {
    it("removes items with duplicate URLs", () => {
      const items = [
        makeItem({ itemId: "a", content: "Check out https://example.com/article1" }),
        makeItem({ itemId: "b", content: "Also see https://example.com/article1" }),
        makeItem({ itemId: "c", content: "Different https://example.com/other" }),
      ]
      const result = dedup.deduplicateByUrl(items)
      expect(result).toHaveLength(2)
      expect(result.map((i) => i.itemId)).toContain("a")
      expect(result.map((i) => i.itemId)).toContain("c")
    })

    it("normalizes UTM params", () => {
      const items = [
        makeItem({ itemId: "a", content: "https://example.com/page?utm_source=twitter" }),
        makeItem({ itemId: "b", content: "https://example.com/page?utm_source=telegram" }),
      ]
      const result = dedup.deduplicateByUrl(items)
      expect(result).toHaveLength(1)
    })

    it("keeps items without URLs", () => {
      const items = [
        makeItem({ itemId: "a", content: "No URL here" }),
        makeItem({ itemId: "b", content: "Also no URL" }),
      ]
      const result = dedup.deduplicateByUrl(items)
      expect(result).toHaveLength(2)
    })
  })

  describe("deduplicateBySimilarity", () => {
    it("removes highly similar items", () => {
      const items = [
        makeItem({ itemId: "a", content: "New AI startup launches revolutionary product for developers" }),
        makeItem({ itemId: "b", content: "New AI startup launches revolutionary product for engineers" }),
        makeItem({ itemId: "c", content: "Weather forecast shows sunny weekend ahead for Sydney" }),
      ]
      const result = dedup.deduplicateBySimilarity(items, 0.7)
      expect(result).toHaveLength(2)
      expect(result.map((i) => i.itemId)).toContain("a")
      expect(result.map((i) => i.itemId)).toContain("c")
    })

    it("keeps dissimilar items", () => {
      const items = [
        makeItem({ itemId: "a", content: "Apple releases new iPhone model with AI features" }),
        makeItem({ itemId: "b", content: "Bitcoin hits all time high amid market uncertainty" }),
      ]
      const result = dedup.deduplicateBySimilarity(items, 0.8)
      expect(result).toHaveLength(2)
    })
  })
})

describe("trigramJaccard", () => {
  it("returns 1 for identical strings", () => {
    expect(trigramJaccard("hello world", "hello world")).toBe(1)
  })

  it("returns 0 for completely different strings", () => {
    const sim = trigramJaccard("aaa", "zzz")
    expect(sim).toBe(0)
  })

  it("returns high similarity for near-identical strings", () => {
    const sim = trigramJaccard(
      "The quick brown fox jumps over the lazy dog",
      "The quick brown fox leaps over the lazy dog",
    )
    expect(sim).toBeGreaterThan(0.7)
  })
})
