import { describe, it, expect, beforeAll } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { loadConfig } from "../../src/config/config-loader.js"
import { initLoggers } from "../../src/logger/index.js"

describe("integration: startup chain", () => {
  beforeAll(() => {
    const config = loadConfig()
    initLoggers(config as any)
  })

  it("loadConfig succeeds when openceph.json is valid", () => {
    // Verify that loadConfig doesn't throw with the real config
    // This validates step 1 of the startup chain
    const config = loadConfig()
    expect(config).toBeDefined()
    expect(config.agents.defaults.model.primary).toBeTruthy()
    expect(config.tentacle.ipcSocketPath).toBeTruthy()
  })

  it("loadConfig exposes tentacle model configuration", () => {
    const config = loadConfig()
    // Verify the tentacle model section is populated (needed for buildTentacleModelEnv)
    const tentacle = (config as any).tentacle
    expect(tentacle).toBeDefined()
    if (tentacle.model?.primary) {
      expect(tentacle.model.primary).toContain("/")
    }
  })

  it("buildTentacleModelEnv generates expected env vars from config", async () => {
    const config = loadConfig()
    const { buildTentacleModelEnv } = await import("../../src/config/model-runtime.js")
    const env = buildTentacleModelEnv(config)

    // If tentacle model is configured, env should contain standard vars
    if ((config as any).tentacle?.model?.primary) {
      expect(env.OPENCEPH_LLM_PROVIDER).toBeTruthy()
      expect(env.OPENCEPH_LLM_FULL_MODEL).toBeTruthy()
      expect(env.OPENCEPH_LLM_MODEL).toBeTruthy()
      // API key should be resolved (not a "from:credentials/" reference)
      if (env.OPENCEPH_LLM_API_KEY) {
        expect(env.OPENCEPH_LLM_API_KEY).not.toMatch(/^from:/)
      }
    }
  })

  it("skill discovery finds builtin tentacles", async () => {
    const config = loadConfig()
    const { SkillLoader } = await import("../../src/skills/skill-loader.js")
    const loader = new SkillLoader(config.skills.paths)
    await loader.loadAll()

    // Core builtin skill must exist
    expect(loader.get("hn-radar")).toBeDefined()
  })
})
