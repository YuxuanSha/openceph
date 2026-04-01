import type { OpenCephConfig } from "../config/config-schema.js"
import type { PiContext } from "../pi/pi-context.js"
import { AuthProfileManager } from "../gateway/auth/auth-profiles.js"
import { systemLogger } from "../logger/index.js"

export interface ResolvedModel {
  provider: string
  modelId: string
  fullModelId: string
  baseUrl: string
  apiKey: string
  api: string
  /** The auth profile ID used for this resolution (for cooldown tracking). */
  profileId?: string
}

/**
 * Resolves the `model` field from a chat completion request into a concrete model config.
 *
 * Resolution order:
 * 1. Pi ModelRegistry — the same registry Brain uses. If the model is registered there,
 *    we get its baseUrl, api, and provider directly from Pi.
 * 2. Config fallback — for tentacle-specific overrides not in Pi's registry.
 *
 * Auth resolution:
 * 1. Pi AuthStorage.getApiKey(provider) — runtime-injected keys, same source as Brain.
 * 2. AuthProfileManager with cooldown/failover — shared instance with Gateway/Brain.
 * 3. Config profiles fallback.
 */
export class ModelResolver {
  private primaryModel: string | undefined
  private fallbackModels: string[]
  private providers: Record<string, { baseUrl?: string; api?: string }>
  private authProfiles: Record<string, { mode?: string; apiKey?: string }>
  private authOrder: Record<string, string[]>
  private authProfileManager: AuthProfileManager
  private piCtx: PiContext | undefined

  constructor(config: OpenCephConfig, authProfileManager: AuthProfileManager, piCtx?: PiContext) {
    const tentacle = config.tentacle
    const agentDefaults = config.agents.defaults
    const brainModels = config.models ?? { providers: {}, named: {} }
    const brainAuth = config.auth ?? { profiles: {}, order: {} }

    this.primaryModel =
      tentacle.model?.primary ??
      (brainModels.named as Record<string, { model: { primary: string } }>)?.tentacle?.model?.primary ??
      agentDefaults.model.primary

    this.fallbackModels =
      tentacle.model?.fallbacks ??
      agentDefaults.model.fallbacks ??
      []

    this.providers = {
      ...(brainModels.providers as Record<string, { baseUrl?: string; api?: string }>),
      ...(tentacle.providers as Record<string, { baseUrl?: string; api?: string }>),
    }

    this.authProfiles = {
      ...(brainAuth.profiles as Record<string, { mode?: string; apiKey?: string }>),
      ...((tentacle.auth?.profiles ?? {}) as Record<string, { mode?: string; apiKey?: string }>),
    }

    this.authOrder = {
      ...(brainAuth.order as Record<string, string[]>),
      ...((tentacle.auth?.order ?? {}) as Record<string, string[]>),
    }

    // Same AuthProfileManager instance as Brain/Gateway → unified cooldown/failover state
    this.authProfileManager = authProfileManager
    this.piCtx = piCtx
  }

  /** Mark an auth profile as in cooldown (e.g. after 429/401). */
  markProfileCooldown(profileId: string): void {
    this.authProfileManager.markCooldown(profileId)
  }

  async resolve(modelField: string | undefined): Promise<ResolvedModel> {
    let fullModelId: string

    if (!modelField || modelField === "default") {
      if (!this.primaryModel) {
        throw new ModelResolveError("No primary model configured for tentacles")
      }
      fullModelId = this.primaryModel
    } else if (modelField === "fallback") {
      if (this.fallbackModels.length === 0) {
        throw new ModelResolveError("No fallback models configured")
      }
      fullModelId = this.fallbackModels[0]
    } else {
      fullModelId = modelField
    }

    const { provider, modelId } = this.parseModelId(fullModelId)

    // ─── 1. Try Pi's ModelRegistry (same model layer as Brain) ───
    if (this.piCtx) {
      const piModel = this.piCtx.modelRegistry.find(provider, modelId) as
        | { id: string; provider: string; baseUrl?: string; api?: string } | undefined

      if (piModel) {
        const baseUrl = piModel.baseUrl ?? this.providers[provider]?.baseUrl ?? this.defaultBaseUrl(provider)
        const api = (typeof piModel.api === "string" ? piModel.api : undefined) ?? "openai-completions"

        // Resolve API key: Pi AuthStorage first, then AuthProfileManager fallback
        const apiKeyResult = await this.resolveApiKeyViaPi(provider)
        if (baseUrl && apiKeyResult) {
          systemLogger.info("llm_gateway_pi_resolve", {
            model: fullModelId,
            provider,
            source: apiKeyResult.source,
          })
          return {
            provider,
            modelId,
            fullModelId,
            baseUrl,
            apiKey: apiKeyResult.apiKey,
            api,
            profileId: apiKeyResult.profileId,
          }
        }
      }
    }

    // ─── 2. Config fallback (tentacle-specific providers not in Pi registry) ───
    const providerConfig = this.providers[provider]
    const baseUrl = providerConfig?.baseUrl ?? this.defaultBaseUrl(provider)
    const api = providerConfig?.api ?? "openai-completions"
    const resolved = this.resolveApiKeyFromConfig(provider)

    if (!baseUrl) {
      throw new ModelResolveError(`No base URL configured for provider "${provider}"`)
    }
    if (!resolved) {
      throw new ModelResolveError(`No API key found for provider "${provider}" (all profiles may be in cooldown)`)
    }

    return { provider, modelId, fullModelId, baseUrl, apiKey: resolved.apiKey, api, profileId: resolved.profileId }
  }

  listModels(): Array<{ id: string; owned_by: string }> {
    const models: Array<{ id: string; owned_by: string }> = []
    if (this.primaryModel) {
      const { provider } = this.parseModelId(this.primaryModel)
      models.push({ id: this.primaryModel, owned_by: provider })
    }
    for (const fb of this.fallbackModels) {
      const { provider } = this.parseModelId(fb)
      models.push({ id: fb, owned_by: provider })
    }
    return models
  }

  private parseModelId(fullModelId: string): { provider: string; modelId: string } {
    const configuredProviders = new Set([
      ...Object.keys(this.providers),
      ...Object.keys(this.authOrder),
      ...Object.keys(this.authProfiles)
        .map((id) => id.split(":")[0])
        .filter(Boolean),
    ])

    const parts = fullModelId.split("/")
    if (parts.length >= 2 && configuredProviders.has(parts[0])) {
      return { provider: parts[0], modelId: parts.slice(1).join("/") }
    }
    if (configuredProviders.has("openrouter")) {
      return { provider: "openrouter", modelId: fullModelId }
    }
    if (parts.length >= 2) {
      return { provider: parts[0], modelId: parts.slice(1).join("/") }
    }
    throw new ModelResolveError(`Cannot determine provider for model "${fullModelId}"`)
  }

  /**
   * Resolve API key through Pi's AuthStorage first (same key source as Brain),
   * then fall back to AuthProfileManager (with cooldown awareness).
   */
  private async resolveApiKeyViaPi(
    provider: string,
  ): Promise<{ apiKey: string; profileId?: string; source: string } | undefined> {
    // 1. Pi's AuthStorage — the authoritative key source, same as Brain uses
    if (this.piCtx) {
      try {
        const piKey = await this.piCtx.authStorage.getApiKey(provider)
        if (piKey && typeof piKey === "string") {
          // Check cooldown on all profiles for this provider before using the key
          const activeProfile = this.authProfileManager.getActiveProfile(provider)
          if (activeProfile) {
            return { apiKey: piKey, profileId: activeProfile.profileId, source: "pi_authstorage" }
          }
          // No cooldown tracking available, use key directly
          return { apiKey: piKey, source: "pi_authstorage" }
        }
      } catch {
        // Pi AuthStorage may not have this provider — fall through
      }
    }

    // 2. AuthProfileManager with cooldown/failover
    const fromConfig = this.resolveApiKeyFromConfig(provider)
    if (fromConfig) {
      return { ...fromConfig, source: "auth_profile_manager" }
    }

    return undefined
  }

  /** Resolve API key from config profiles with AuthProfileManager cooldown checks. */
  private resolveApiKeyFromConfig(provider: string): { apiKey: string; profileId: string } | undefined {
    // Use AuthProfileManager which respects cooldown
    const active = this.authProfileManager.getActiveProfile(provider)
    if (active?.apiKey) {
      return { apiKey: active.apiKey, profileId: active.profileId }
    }

    // Fallback: iterate merged auth order with cooldown check
    const ordered = this.authOrder[provider] ?? []
    for (const profileId of ordered) {
      if (this.authProfileManager.isInCooldown(profileId)) continue
      const profile = this.authProfiles[profileId]
      if (profile?.mode === "api_key" && profile.apiKey) {
        return { apiKey: profile.apiKey, profileId }
      }
    }

    // Last resort: search by provider prefix
    for (const [profileId, profile] of Object.entries(this.authProfiles)) {
      if (this.authProfileManager.isInCooldown(profileId)) continue
      if (profileId.startsWith(`${provider}:`) && profile.mode === "api_key" && profile.apiKey) {
        return { apiKey: profile.apiKey, profileId }
      }
    }
    return undefined
  }

  private defaultBaseUrl(provider: string): string | undefined {
    if (provider === "openrouter") return "https://openrouter.ai/api/v1"
    if (provider === "openai") return "https://api.openai.com/v1"
    return undefined
  }
}

export class ModelResolveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelResolveError"
  }
}
