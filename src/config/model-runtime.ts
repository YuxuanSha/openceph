import type { OpenCephConfig } from "./config-schema.js"

export interface TentacleModelRuntimeConfig {
  provider: string
  fullModelId: string
  modelId: string
  fallbacks: string[]
  api?: string
  baseUrl?: string
  apiKey?: string
  params?: Record<string, unknown>
}

export function buildTentacleModelEnv(config: OpenCephConfig): Record<string, string> {
  const runtime = resolveTentacleModelRuntime(config)
  if (!runtime) return {}

  const env: Record<string, string> = {
    OPENCEPH_LLM_PROVIDER: runtime.provider,
    OPENCEPH_LLM_FULL_MODEL: runtime.fullModelId,
    OPENCEPH_LLM_MODEL: runtime.modelId,
  }

  if (runtime.api) env.OPENCEPH_LLM_API = runtime.api
  if (runtime.baseUrl) env.OPENCEPH_LLM_BASE_URL = runtime.baseUrl
  if (runtime.apiKey) env.OPENCEPH_LLM_API_KEY = runtime.apiKey
  if (runtime.fallbacks.length > 0) env.OPENCEPH_LLM_FALLBACKS_JSON = JSON.stringify(runtime.fallbacks)
  if (runtime.params && Object.keys(runtime.params).length > 0) {
    env.OPENCEPH_LLM_PARAMS_JSON = JSON.stringify(runtime.params)
  }

  const providerPrefix = runtime.provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
  if (runtime.apiKey) env[`${providerPrefix}_API_KEY`] = runtime.apiKey
  env[`${providerPrefix}_MODEL`] = runtime.modelId
  if (runtime.baseUrl) env[`${providerPrefix}_BASE_URL`] = runtime.baseUrl
  if (runtime.api) env[`${providerPrefix}_API`] = runtime.api

  return env
}

export function resolveTentacleModelRuntime(config: OpenCephConfig): TentacleModelRuntimeConfig | null {
  const brainModelsConfig = (config.models ?? { providers: {}, named: {} }) as NonNullable<OpenCephConfig["models"]>
  const brainAuthConfig = (config.auth ?? { profiles: {}, order: {} }) as NonNullable<OpenCephConfig["auth"]>
  const agentDefaults = ((config as {
    agents?: {
      defaults?: {
        model?: { primary?: string; fallbacks?: string[] }
        models?: Record<string, { params?: Record<string, unknown> }>
      }
    }
  }).agents?.defaults ?? {})
  const tentacleConfig = ((config as {
    tentacle?: {
      model?: { primary?: string; fallbacks?: string[] }
      models?: Record<string, { params?: Record<string, unknown> }>
      providers?: Record<string, { baseUrl?: string; api?: string }>
      auth?: {
        profiles?: Record<string, { mode?: string; apiKey?: string }>
        order?: Record<string, string[]>
      }
    }
  }).tentacle ?? {})
  const modelsConfig = {
    providers: tentacleConfig.providers ?? brainModelsConfig.providers ?? {},
    named: brainModelsConfig.named ?? {},
  }
  const authConfig = {
    profiles: tentacleConfig.auth?.profiles ?? brainAuthConfig.profiles ?? {},
    order: tentacleConfig.auth?.order ?? brainAuthConfig.order ?? {},
  }

  const fullModelId = tentacleConfig.model?.primary
    ?? modelsConfig.named.tentacle?.model.primary
    ?? agentDefaults.model?.primary
  if (!fullModelId) return null

  const configuredProviders = new Set<string>([
    ...Object.keys(modelsConfig.providers ?? {}),
    ...Object.keys(authConfig.order ?? {}),
    ...Object.keys(authConfig.profiles ?? {}).map((profileId) => profileId.split(":")[0]).filter(Boolean),
  ])

  const parts = fullModelId.split("/")
  let provider = ""
  let modelId = fullModelId

  if (parts.length >= 2 && configuredProviders.has(parts[0])) {
    provider = parts[0]
    modelId = parts.slice(1).join("/")
  } else if (configuredProviders.has("openrouter")) {
    provider = "openrouter"
    modelId = fullModelId
  } else if (parts.length >= 2) {
    provider = parts[0]
    modelId = parts.slice(1).join("/")
  } else {
    return null
  }

  const providerConfig = modelsConfig.providers?.[provider] as {
    api?: string
    baseUrl?: string
  } | undefined

  const perModelConfig = tentacleConfig.models?.[fullModelId]
    ?? agentDefaults.models?.[fullModelId]

  return {
    provider,
    fullModelId,
    modelId,
    fallbacks: tentacleConfig.model?.fallbacks ?? modelsConfig.named.tentacle?.model.fallbacks ?? agentDefaults.model?.fallbacks ?? [],
    api: providerConfig?.api ?? "openai-completions",
    baseUrl: providerConfig?.baseUrl ?? defaultBaseUrlForProvider(provider),
    apiKey: resolveProviderApiKey(provider, authConfig),
    params: perModelConfig?.params,
  }
}

function resolveProviderApiKey(
  provider: string,
  authConfig: {
    profiles?: Record<string, { mode?: string; apiKey?: string }>
    order?: Record<string, string[]>
  },
): string | undefined {
  const profiles = authConfig.profiles as Record<string, { mode?: string; apiKey?: string }> | undefined
  if (!profiles) return undefined

  const orderedProfiles = authConfig.order?.[provider] ?? []
  for (const profileId of orderedProfiles) {
    const profile = profiles[profileId]
    if (profile?.mode === "api_key" && profile.apiKey) return profile.apiKey
  }

  for (const [profileId, profile] of Object.entries(profiles)) {
    if (profileId.startsWith(`${provider}:`) && profile.mode === "api_key" && profile.apiKey) {
      return profile.apiKey
    }
  }

  return undefined
}

function defaultBaseUrlForProvider(provider: string): string | undefined {
  if (provider === "openrouter") return "https://openrouter.ai/api/v1"
  if (provider === "openai") return "https://api.openai.com/v1"
  return undefined
}
