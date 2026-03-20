import type { AuthStorage } from "@mariozechner/pi-coding-agent"
import type { OpenCephConfig } from "../config/config-schema.js"

/**
 * Inject API keys from config.auth.profiles into Pi's AuthStorage.
 * Runtime-only — not persisted to auth.json.
 */
export function injectApiKeys(authStorage: AuthStorage, config: OpenCephConfig): void {
  const profiles = config.auth.profiles as Record<string, { mode: string; apiKey?: string }>
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (profile.mode === "api_key" && profile.apiKey) {
      const provider = profileId.split(":")[0]
      authStorage.setRuntimeApiKey(provider, profile.apiKey)
    }
  }
}
