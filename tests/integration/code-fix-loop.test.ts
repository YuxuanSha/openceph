import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import { CodeAgent } from "../../src/code-agent/code-agent.js"
import { TentacleValidator } from "../../src/code-agent/validator.js"
import { createTempIntegrationDir, initIntegrationConfig } from "./helpers.js"

describe("integration: code fix loop", () => {
  let dir: string

  beforeEach(() => {
    dir = createTempIntegrationDir("openceph-code-fix-")
    initIntegrationConfig(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("generates and fixes tentacle code while keeping validation green", async () => {
    const agent = new CodeAgent({} as any, {} as any)
    const validator = new TentacleValidator()
    const requirement = {
      tentacleId: "t_rss_fix",
      purpose: "monitor AI RSS feeds",
      workflow: "Poll RSS feeds, batch routine findings, escalate urgent items",
      capabilities: ["web_search", "scheduled_task"] as const,
      reportStrategy: "Use consultation_request for batch delivery",
      preferredRuntime: "python" as const,
      userContext: "",
    }

    const generated = await agent.generate(requirement)
    const firstPass = await validator.validateAll(generated)
    expect(firstPass.passed).toBe(true)

    const fixed = await agent.fix(generated, [{
      check: "contract",
      message: "Tighten feed summary formatting for batched consultation replies",
      suggestion: "Keep the IPC contract unchanged while improving summaries",
    }], requirement)
    const secondPass = await validator.validateAll(fixed)

    expect(secondPass.passed).toBe(true)
    expect(fixed.files.some((file) => file.path.endsWith(".py"))).toBe(true)
    expect(fixed.description).toContain("monitor AI RSS feeds")
  }, 20_000)
})
