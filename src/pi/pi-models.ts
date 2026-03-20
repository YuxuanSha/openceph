import type { OpenCephConfig } from "../config/config-schema.js"
import * as fs from "fs/promises"
import { readFileSync, existsSync } from "fs"
import * as path from "path"

interface PiModelDef {
  id: string
  name: string
  api?: string
  reasoning: boolean
  input: string[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
}

interface PiProviderConfig {
  baseUrl?: string
  api?: string
  apiKey?: string
  models?: PiModelDef[]
}

interface PiModelsJson {
  providers: Record<string, PiProviderConfig>
  models: Array<PiModelDef & { provider: string; api: string }>
}

// Default model definitions for common OpenRouter models
const DEFAULT_OPENROUTER_MODELS: PiModelDef[] = [
  {
    id: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 (via OpenRouter)",
    reasoning: false,
    input: ["text"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "anthropic/claude-opus-4-5",
    name: "Claude Opus 4.5 (via OpenRouter)",
    reasoning: false,
    input: ["text"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o (via OpenRouter)",
    reasoning: false,
    input: ["text"],
    cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
    contextWindow: 128000,
    maxTokens: 16384,
  },
]

/**
 * Resolve the API key for a provider from config.auth.profiles.
 */
function resolveProviderApiKey(providerName: string, config: OpenCephConfig): string | undefined {
  const profiles = config.auth?.profiles as Record<string, { mode: string; apiKey?: string }> | undefined
  if (!profiles) return undefined
  const order = (config.auth as any)?.order?.[providerName] as string[] | undefined
  if (order) {
    for (const profileId of order) {
      const profile = profiles[profileId]
      if (profile?.mode === "api_key" && profile.apiKey) return profile.apiKey
    }
  }
  // Fallback: search for any profile matching the provider
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (profileId.startsWith(`${providerName}:`) && profile.mode === "api_key" && profile.apiKey) {
      return profile.apiKey
    }
  }
  return undefined
}

/**
 * Generate Pi's models.json from config.models.providers.
 * Models are placed inside each provider (Pi's expected format).
 * Skips write if content is unchanged.
 */
export async function writeModelsJson(
  modelsJsonPath: string,
  config: OpenCephConfig,
): Promise<void> {
  const providers: Record<string, PiProviderConfig> = {}
  const flattenedModels: Array<PiModelDef & { provider: string; api: string }> = []

  const configProviders = config.models.providers as Record<string, { baseUrl?: string; apiKey?: string; api?: string; models?: any[] }>
  for (const [name, provider] of Object.entries(configProviders)) {
    const providerModels: PiModelDef[] = []

    // Add default model entries for known providers
    if (name === "openrouter") {
      providerModels.push(...DEFAULT_OPENROUTER_MODELS)
    }

    // Merge custom models from config (override defaults with same id)
    if (provider.models && Array.isArray(provider.models)) {
      for (const customModel of provider.models) {
        const existingIdx = providerModels.findIndex((m) => m.id === customModel.id)
        const entry: PiModelDef = {
          id: customModel.id,
          name: customModel.name ?? customModel.id,
          reasoning: customModel.reasoning ?? false,
          input: customModel.input ?? ["text"],
          cost: customModel.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: customModel.contextWindow ?? 200000,
          maxTokens: customModel.maxTokens ?? 64000,
        }
        if (existingIdx >= 0) {
          providerModels[existingIdx] = entry
        } else {
          providerModels.push(entry)
        }
      }
    }

    const providerConfig: PiProviderConfig = {
      baseUrl: provider.baseUrl,
      api: provider.api,
    }

    // Include models and apiKey (required by Pi when models are defined)
    if (providerModels.length > 0) {
      const apiKey = resolveProviderApiKey(name, config)
      if (apiKey) {
        providerConfig.apiKey = apiKey
      }
      providerConfig.models = providerModels
      const providerApi = provider.api ?? "openai-completions"
      for (const model of providerModels) {
        flattenedModels.push({
          ...model,
          provider: name,
          api: providerApi,
        })
      }
    }

    providers[name] = providerConfig
  }

  const piModels: PiModelsJson = { providers, models: flattenedModels }
  const newContent = JSON.stringify(piModels, null, 2)

  // Skip write if content unchanged
  if (existsSync(modelsJsonPath)) {
    try {
      const existing = readFileSync(modelsJsonPath, "utf-8")
      if (existing === newContent) return
    } catch {
      // File exists but unreadable, overwrite
    }
  }

  await fs.mkdir(path.dirname(modelsJsonPath), { recursive: true })
  await fs.writeFile(modelsJsonPath, newContent, "utf-8")
}
