/**
 * Smart model routing: resolves model IDs based on which providers
 * have API keys configured. If a model's provider has no key but
 * OpenRouter does, automatically reroute through OpenRouter.
 */

type AuthProfile = { mode?: string; apiKey?: string }

/** Check whether any auth profile for the given provider has an API key. */
function hasProviderKey(
  provider: string,
  authProfiles: Record<string, AuthProfile>,
): boolean {
  for (const [profileId, profile] of Object.entries(authProfiles)) {
    if (profileId.startsWith(`${provider}:`) && profile.mode === "api_key" && profile.apiKey) {
      return true
    }
  }
  return false
}

/**
 * Extract provider from a model ID string.
 * e.g. "openrouter/anthropic/claude-sonnet-4-6" → "openrouter"
 *      "anthropic/claude-sonnet-4-6" → "anthropic"
 */
function extractProvider(modelId: string): string | undefined {
  const slash = modelId.indexOf("/")
  return slash > 0 ? modelId.slice(0, slash) : undefined
}

/**
 * Resolve a single model ID to the best available route.
 *
 * Priority:
 * 1. If the model's provider has a configured API key → use as-is
 * 2. If OpenRouter has a configured API key → reroute as openrouter/{modelId}
 * 3. Otherwise → return as-is (let downstream report the missing key)
 */
export function resolveModelRoute(
  modelId: string,
  authProfiles: Record<string, AuthProfile>,
): string {
  const provider = extractProvider(modelId)
  if (!provider) return modelId

  // Already routed through a provider that has a key — use as-is
  if (hasProviderKey(provider, authProfiles)) return modelId

  // Provider is already openrouter but no key — nothing we can do
  if (provider === "openrouter") return modelId

  // Try rerouting through OpenRouter
  if (hasProviderKey("openrouter", authProfiles)) {
    return `openrouter/${modelId}`
  }

  return modelId
}

/**
 * Resolve primary + fallbacks model config through smart routing.
 */
export function resolveModelConfig(
  primary: string,
  fallbacks: string[],
  authProfiles: Record<string, AuthProfile>,
): { primary: string; fallbacks: string[] } {
  return {
    primary: resolveModelRoute(primary, authProfiles),
    fallbacks: fallbacks.map((fb) => resolveModelRoute(fb, authProfiles)),
  }
}
