import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { createPiContext } from "../../src/pi/pi-context.js"
import { writeModelsJson } from "../../src/pi/pi-models.js"
import { injectApiKeys } from "../../src/pi/pi-auth.js"
import type { OpenCephConfig } from "../../src/config/config-schema.js"

function createTestConfig(overrides?: Partial<OpenCephConfig>): OpenCephConfig {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-ws-test-"))

  // Create minimal workspace files that Pi expects
  fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), "# Test Agent")

  return {
    meta: { version: "3.2" },
    gateway: {
      port: 18790,
      bind: "loopback",
      auth: { mode: "token", token: "test" },
    },
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: { primary: "anthropic/claude-sonnet-4-5", fallbacks: [] },
        userTimezone: "UTC",
        bootstrapMaxChars: 20000,
        bootstrapTotalMaxChars: 150000,
      },
    },
    models: {
      providers: {
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-completions",
        },
      },
    },
    auth: {
      profiles: {
        "openrouter:primary": {
          mode: "api_key",
          apiKey: "sk-test-key",
        },
      },
      order: { openrouter: ["openrouter:primary"] },
      cooldown: "5m",
      cacheRetention: "long",
    },
    session: {
      dmScope: "main",
      mainKey: "main",
      reset: { mode: "daily", atHour: 4 },
      resetTriggers: ["/new", "/reset"],
      cleanup: {
        maxArchiveFilesPerKey: 30,
        archiveTtlDays: 90,
        heartbeatRetentionDays: 7,
        consultationRetentionDays: 30,
      },
    },
    logging: {
      logDir: path.join(os.tmpdir(), "openceph-logs-test"),
      level: "INFO",
      rotateSizeMb: 50,
      keepDays: 30,
      cacheTrace: true,
    },
    cost: { dailyLimitUsd: 0.5, alertThresholdUsd: 0.4 },
    commands: { config: false, debug: false, bash: false },
    ...overrides,
  } as OpenCephConfig
}

describe("Pi Context", () => {
  it("createPiContext returns non-null components", async () => {
    const config = createTestConfig()
    const ctx = await createPiContext(config)

    expect(ctx.authStorage).toBeTruthy()
    expect(ctx.modelRegistry).toBeTruthy()
    expect(ctx.resourceLoader).toBeTruthy()
    expect(ctx.settingsManager).toBeTruthy()
    expect(ctx.agentDir).toContain(".openceph/brain")
    expect(ctx.workspaceDir).toBe(config.agents.defaults.workspace)
  })

  it("writeModelsJson generates valid JSON", async () => {
    const config = createTestConfig()
    const modelsPath = path.join(os.tmpdir(), `openceph-models-test-${Date.now()}.json`)

    await writeModelsJson(modelsPath, config)

    const content = JSON.parse(fs.readFileSync(modelsPath, "utf-8"))
    expect(content.providers).toBeDefined()
    expect(content.providers.openrouter).toBeDefined()
    expect(content.providers.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1")
    expect(content.models).toBeInstanceOf(Array)
    expect(content.models.length).toBeGreaterThan(0)

    // Each model should have required fields
    for (const model of content.models) {
      expect(model.id).toBeTruthy()
      expect(model.provider).toBe("openrouter")
      expect(model.api).toBeTruthy()
      expect(model.contextWindow).toBeGreaterThan(0)
    }

    // Cleanup
    fs.unlinkSync(modelsPath)
  })

  it("writeModelsJson skips write if content unchanged", async () => {
    const config = createTestConfig()
    const modelsPath = path.join(os.tmpdir(), `openceph-models-test-${Date.now()}.json`)

    await writeModelsJson(modelsPath, config)
    const mtime1 = fs.statSync(modelsPath).mtimeMs

    // Small delay to ensure different mtime if file were rewritten
    await new Promise((r) => setTimeout(r, 50))

    await writeModelsJson(modelsPath, config)
    const mtime2 = fs.statSync(modelsPath).mtimeMs

    expect(mtime1).toBe(mtime2)

    fs.unlinkSync(modelsPath)
  })
})
