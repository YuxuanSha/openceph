export class SearchCache {
  private cache: Map<string, { result: unknown; expiresAt: number }> = new Map()
  private ttlMs: number

  constructor(ttlMinutes: number = 15) {
    this.ttlMs = ttlMinutes * 60 * 1000
  }

  get(query: string): unknown | null {
    const entry = this.cache.get(query)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(query)
      return null
    }
    return entry.result
  }

  set(query: string, result: unknown): void {
    this.cache.set(query, {
      result,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  clear(): void {
    this.cache.clear()
  }
}
