import { getModels, type KnownProvider } from "@mariozechner/pi-ai"
import type { OpenCephConfig } from "../config/config-schema.js"
import type { PiContext } from "./pi-context.js"

export interface ModelResolution {
  modelId: string
  source: "preferred" | "primary" | "fallback"
  reasons: string[]
}

interface ResolveRunnableModelOptions {
  piCtx: PiContext
  config: OpenCephConfig
  preferredModel?: string
}

export function resolveRunnableModel(options: ResolveRunnableModelOptions): ModelResolution {
  const candidates = dedupe([
    options.preferredModel,
    options.config.agents.defaults.model.primary,
    ...options.config.agents.defaults.model.fallbacks,
  ])

  const reasons: string[] = []
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]
    if (!candidate) continue

    const availability = checkModelAvailability(candidate, options.piCtx, options.config)
    if (availability.ok) {
      return {
        modelId: candidate,
        source: i === 0 && candidate === options.preferredModel
          ? "preferred"
          : candidate === options.config.agents.defaults.model.primary
            ? "primary"
            : "fallback",
        reasons,
      }
    }
    reasons.push(`${candidate}: ${availability.reason}`)
  }

  throw new Error(`No runnable model available. ${reasons.join("; ")}`)
}

function checkModelAvailability(
  modelId: string,
  piCtx: PiContext,
  config: OpenCephConfig,
): { ok: true } | { ok: false; reason: string } {
  const [provider, ...rest] = modelId.split("/")
  const id = rest.join("/")
  if (!provider || !id) {
    return { ok: false, reason: "invalid model id" }
  }

  let model = piCtx.modelRegistry.find(provider, id)
  if (!model) {
    try {
      model = getModels(provider as KnownProvider).find((entry: any) => entry.id === id)
    } catch {
      model = undefined
    }
  }

  if (!model) {
    return { ok: false, reason: "model not found in registry" }
  }

  if (!providerHasAccess(provider, config)) {
    return { ok: false, reason: `provider ${provider} has no configured credentials` }
  }

  return { ok: true }
}

function providerHasAccess(provider: string, config: OpenCephConfig): boolean {
  const customProvider = config.models.providers[provider]
  if (customProvider) {
    if (customProvider.apiKey) return true
    return true
  }

  const orderedProfiles = config.auth.order[provider]
  if (orderedProfiles && orderedProfiles.length > 0) {
    for (const profileId of orderedProfiles) {
      const profile = config.auth.profiles[profileId]
      if (!profile) continue
      if (profile.mode === "oauth") return true
      if (profile.mode === "api_key" && profile.apiKey) return true
    }
  }

  for (const [profileId, profile] of Object.entries(config.auth.profiles)) {
    if (!profileId.startsWith(`${provider}:`)) continue
    if (profile.mode === "oauth") return true
    if (profile.mode === "api_key" && profile.apiKey) return true
  }

  return false
}

function dedupe(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}
