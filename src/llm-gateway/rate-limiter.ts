import type { Request, Response, NextFunction } from "express"
import type { OpenCephConfig } from "../config/config-schema.js"

interface BucketEntry {
  count: number
  windowStart: number
}

/**
 * Simple sliding-window rate limiter for LLM Gateway.
 * Tracks requests per tentacle and globally within 60-second windows.
 */
export class RateLimiter {
  private globalBucket: BucketEntry = { count: 0, windowStart: Date.now() }
  private tentacleBuckets: Map<string, BucketEntry> = new Map()
  private maxGlobal: number
  private maxPerTentacle: number
  private readonly WINDOW_MS = 60_000

  constructor(config: OpenCephConfig) {
    const rl = config.gateway!.rateLimit!
    this.maxGlobal = rl.maxRequestsPerMinute
    this.maxPerTentacle = rl.maxRequestsPerTentacle
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      // Only rate-limit /v1/* endpoints
      if (!req.path.startsWith("/v1/")) {
        next()
        return
      }

      const now = Date.now()
      const tentacleId = req.headers["x-tentacle-id"] as string | undefined

      // Global rate limit
      if (now - this.globalBucket.windowStart > this.WINDOW_MS) {
        this.globalBucket = { count: 0, windowStart: now }
      }
      if (this.globalBucket.count >= this.maxGlobal) {
        res.status(429).json({
          error: {
            message: `Global rate limit exceeded (${this.maxGlobal} req/min)`,
            type: "rate_limit_error",
          },
        })
        return
      }

      // Per-tentacle rate limit
      if (tentacleId) {
        let bucket = this.tentacleBuckets.get(tentacleId)
        if (!bucket || now - bucket.windowStart > this.WINDOW_MS) {
          bucket = { count: 0, windowStart: now }
          this.tentacleBuckets.set(tentacleId, bucket)
        }
        if (bucket.count >= this.maxPerTentacle) {
          res.status(429).json({
            error: {
              message: `Tentacle rate limit exceeded (${this.maxPerTentacle} req/min) for ${tentacleId}`,
              type: "rate_limit_error",
            },
          })
          return
        }
        bucket.count++
      }

      this.globalBucket.count++
      next()
    }
  }

  /** Periodic cleanup of stale tentacle buckets */
  cleanup(): void {
    const now = Date.now()
    for (const [id, bucket] of this.tentacleBuckets) {
      if (now - bucket.windowStart > this.WINDOW_MS * 5) {
        this.tentacleBuckets.delete(id)
      }
    }
  }
}
