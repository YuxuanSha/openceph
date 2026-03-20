import type { OpenCephConfig } from "../../config/config-schema.js"
import { gatewayLogger } from "../../logger/index.js"

interface CooldownEntry {
  profileId: string
  until: number // timestamp ms
}

export class AuthProfileManager {
  private cooldowns: Map<string, CooldownEntry> = new Map()
  private cooldownMs: number

  constructor(private config: OpenCephConfig) {
    this.cooldownMs = parseDuration(config.auth.cooldown)
  }

  /** Get the active profile for a provider (skip cooldown ones) */
  getActiveProfile(provider: string): { profileId: string; apiKey?: string } | null {
    const order = this.config.auth.order[provider]
    if (!order || order.length === 0) return null

    for (const profileId of order) {
      if (this.isInCooldown(profileId)) continue
      const profile = this.config.auth.profiles[profileId]
      if (profile) {
        return { profileId, apiKey: profile.apiKey }
      }
    }

    return null
  }

  /** Mark a profile as in cooldown (after 429/401) */
  markCooldown(profileId: string): void {
    const until = Date.now() + this.cooldownMs
    this.cooldowns.set(profileId, { profileId, until })
    gatewayLogger.info("auth_profile_cooldown", { profile_id: profileId, until_ms: until })

    // Auto-recovery timer
    setTimeout(() => {
      this.cooldowns.delete(profileId)
      gatewayLogger.info("auth_profile_cooldown_end", { profile_id: profileId })
    }, this.cooldownMs)
  }

  isInCooldown(profileId: string): boolean {
    const entry = this.cooldowns.get(profileId)
    if (!entry) return false
    if (Date.now() > entry.until) {
      this.cooldowns.delete(profileId)
      return false
    }
    return true
  }
}

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(m|s|h)$/)
  if (!match) return 5 * 60 * 1000 // default 5 min
  const val = parseInt(match[1], 10)
  switch (match[2]) {
    case "s": return val * 1000
    case "m": return val * 60 * 1000
    case "h": return val * 60 * 60 * 1000
    default: return val * 60 * 1000
  }
}
