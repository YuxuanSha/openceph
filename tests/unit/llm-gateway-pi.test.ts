import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest"
import { ModelResolver, ModelResolveError } from "../../src/llm-gateway/model-resolver.js"
import { PiModelCaller } from "../../src/llm-gateway/pi-model-caller.js"
import { AuthProfileManager } from "../../src/gateway/auth/auth-profiles.js"
import { initLoggers } from "../../src/logger/index.js"
import type { PiContext } from "../../src/pi/pi-context.js"
import type { OpenCephConfig } from "../../src/config/config-schema.js"

function makeConfig(overrides: Partial<OpenCephConfig> = {}): OpenCephConfig {
  return {
    agents: { defaults: { workspace: "/tmp", model: { primary: "openrouter/google/gemini-2.0-flash", fallbacks: [] }, userTimezone: "UTC", bootstrapMaxChars: 20000, bootstrapTotalMaxChars: 150000 } },
    models: { providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } } },
    auth: {
      profiles: { "openrouter:main": { mode: "api_key", apiKey: "sk-config-key" } },
      order: { openrouter: ["openrouter:main"] },
      cooldown: "5m",
      cacheRetention: "long",
    },
    tentacle: { maxActive: 5, ipcSocketPath: "/tmp/sock", codeGenMaxRetries: 3, crashRestartMaxAttempts: 3, confidenceThresholds: { directReport: 0.8, consultation: 0.4, discard: 0 } },
    logging: { logDir: "/tmp/openceph-test-logs", level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    ...overrides,
  } as unknown as OpenCephConfig
}

function makePiCtx(opts: {
  findResult?: Record<string, unknown> | null
  apiKey?: string | null
} = {}): PiContext {
  return {
    modelRegistry: {
      find: vi.fn().mockReturnValue(opts.findResult ?? null),
      getAll: vi.fn().mockReturnValue([]),
      getAvailable: vi.fn().mockReturnValue([]),
    },
    authStorage: {
      getApiKey: vi.fn().mockResolvedValue(opts.apiKey ?? null),
      hasAuth: vi.fn().mockReturnValue(!!opts.apiKey),
      setRuntimeApiKey: vi.fn(),
    },
    agentDir: "/tmp/brain",
    workspaceDir: "/tmp/workspace",
    resourceLoader: {} as any,
    settingsManager: {} as any,
  } as unknown as PiContext
}

// ─── ModelResolver unit tests ───────────────────────────────────

describe("ModelResolver Pi integration", () => {
  let config: OpenCephConfig
  let apm: AuthProfileManager

  beforeAll(() => {
    initLoggers(makeConfig() as any)
  })

  beforeEach(() => {
    config = makeConfig()
    apm = new AuthProfileManager(config)
  })

  it("resolves model and API key through Pi when model is in Pi registry", async () => {
    const piCtx = makePiCtx({
      findResult: {
        id: "google/gemini-2.0-flash",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
      },
      apiKey: "sk-pi-key-from-authstorage",
    })

    const resolver = new ModelResolver(config, apm, piCtx)
    const result = await resolver.resolve("default")

    expect(result.provider).toBe("openrouter")
    expect(result.modelId).toBe("google/gemini-2.0-flash")
    expect(result.apiKey).toBe("sk-pi-key-from-authstorage")
    expect(result.baseUrl).toBe("https://openrouter.ai/api/v1")

    expect(piCtx.modelRegistry.find).toHaveBeenCalledWith("openrouter", "google/gemini-2.0-flash")
    expect(piCtx.authStorage.getApiKey).toHaveBeenCalledWith("openrouter")
  })

  it("falls back to config when Pi registry does not have the model", async () => {
    const piCtx = makePiCtx({ findResult: null, apiKey: null })
    const resolver = new ModelResolver(config, apm, piCtx)
    const result = await resolver.resolve("default")

    expect(result.provider).toBe("openrouter")
    expect(result.apiKey).toBe("sk-config-key")
    expect(piCtx.modelRegistry.find).toHaveBeenCalled()
  })

  it("works without piCtx (pure config mode)", async () => {
    const resolver = new ModelResolver(config, apm)
    const result = await resolver.resolve("default")

    expect(result.provider).toBe("openrouter")
    expect(result.apiKey).toBe("sk-config-key")
  })

  it("shares cooldown state with AuthProfileManager", async () => {
    const resolver = new ModelResolver(config, apm, makePiCtx())

    const r1 = await resolver.resolve("default")
    expect(r1.apiKey).toBe("sk-config-key")

    resolver.markProfileCooldown("openrouter:main")
    expect(apm.isInCooldown("openrouter:main")).toBe(true)

    await expect(resolver.resolve("default")).rejects.toThrow(ModelResolveError)
  })

  it("prefers Pi auth key over config key when both available", async () => {
    const piCtx = makePiCtx({
      findResult: { id: "google/gemini-2.0-flash", provider: "openrouter", api: "openai-completions" },
      apiKey: "sk-pi-auth-key",
    })
    const resolver = new ModelResolver(config, apm, piCtx)
    const result = await resolver.resolve("default")

    expect(result.apiKey).toBe("sk-pi-auth-key")
  })
})

// ─── PiModelCaller — verifies the full request execution path ───

describe("PiModelCaller request execution path", () => {
  let config: OpenCephConfig
  let apm: AuthProfileManager
  let originalFetch: typeof globalThis.fetch

  beforeAll(() => {
    initLoggers(makeConfig() as any)
  })

  beforeEach(() => {
    config = makeConfig()
    apm = new AuthProfileManager(config)
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("full path: Pi ModelRegistry → Pi AuthStorage → fetch with Pi-resolved values", async () => {
    const piCtx = makePiCtx({
      findResult: {
        id: "google/gemini-2.0-flash",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
      },
      apiKey: "sk-pi-resolved-key",
    })

    const resolver = new ModelResolver(config, apm, piCtx)
    const caller = new PiModelCaller(resolver)

    // Mock fetch to capture the actual call
    let capturedUrl = ""
    let capturedHeaders: Record<string, string> = {}
    let capturedBody = ""
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedUrl = url
      capturedHeaders = Object.fromEntries(
        Object.entries(init.headers as Record<string, string>),
      )
      capturedBody = init.body as string
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof fetch

    const result = await caller.chatCompletions({
      model: "default",
      body: { messages: [{ role: "user", content: "Hi" }] },
      requestId: "req-1",
      tentacleId: "t_test",
    })

    // Verify Pi was consulted
    expect(piCtx.modelRegistry.find).toHaveBeenCalledWith("openrouter", "google/gemini-2.0-flash")
    expect(piCtx.authStorage.getApiKey).toHaveBeenCalledWith("openrouter")

    // Verify fetch used Pi-resolved values
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(capturedHeaders["Authorization"]).toBe("Bearer sk-pi-resolved-key")

    // Verify the model ID in the body is the Pi-resolved modelId
    const body = JSON.parse(capturedBody)
    expect(body.model).toBe("google/gemini-2.0-flash")

    expect(result.response.ok).toBe(true)
    expect(result.resolved.fullModelId).toBe("openrouter/google/gemini-2.0-flash")
  })

  it("retries with fallback profile on 429 via shared cooldown", async () => {
    // Config with TWO profiles
    config = makeConfig({
      auth: {
        profiles: {
          "openrouter:primary": { mode: "api_key", apiKey: "sk-primary" },
          "openrouter:backup": { mode: "api_key", apiKey: "sk-backup" },
        },
        order: { openrouter: ["openrouter:primary", "openrouter:backup"] },
        cooldown: "5m",
        cacheRetention: "long",
      },
    } as any)
    apm = new AuthProfileManager(config)

    const resolver = new ModelResolver(config, apm)
    const caller = new PiModelCaller(resolver)

    let callCount = 0
    const capturedKeys: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      callCount++
      const authHeader = (init.headers as Record<string, string>)["Authorization"]
      capturedKeys.push(authHeader)
      if (callCount === 1) {
        // First call: 429
        return new Response("rate limited", { status: 429 })
      }
      // Second call: success
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof fetch

    const result = await caller.chatCompletions({
      model: "default",
      body: { messages: [{ role: "user", content: "test" }] },
      requestId: "req-2",
      tentacleId: "t_test",
    })

    expect(callCount).toBe(2)
    expect(capturedKeys[0]).toBe("Bearer sk-primary")
    expect(capturedKeys[1]).toBe("Bearer sk-backup")
    expect(result.response.ok).toBe(true)

    // Cooldown should be visible on the shared AuthProfileManager
    expect(apm.isInCooldown("openrouter:primary")).toBe(true)
  })
})
