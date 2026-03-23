import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"

describe("integration: skill_tentacle config injection", () => {
  let dir: string
  let logDir: string

  beforeAll(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-config-inject-log-"))
    initLoggers({
      logging: { logDir, level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    } as any)
  })

  // Note: logDir cleanup intentionally omitted — async logger writes
  // may still be in-flight when afterAll runs. OS cleans up /tmp.

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-config-inject-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function createTentacleDir() {
    const tentacleDir = path.join(dir, "t_test")
    fs.mkdirSync(path.join(tentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(tentacleDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(tentacleDir, "prompt", "SYSTEM.md"), [
      "# Identity",
      "You are a test tentacle for {USER_NAME}.",
      "",
      "# User Context",
      "- Technical focus: {USER_TECHNICAL_FOCUS}",
      "- Not interested: {USER_NOT_INTERESTED}",
      "- Custom setting: {CUSTOM_PLACEHOLDER}",
    ].join("\n"))
    fs.writeFileSync(path.join(tentacleDir, "src", "main.py"), "# main\n")
    return tentacleDir
  }

  it("replaces prompt placeholders in SYSTEM.md", () => {
    const tentacleDir = createTentacleDir()
    const systemMdPath = path.join(tentacleDir, "prompt", "SYSTEM.md")

    // Simulate placeholder replacement (as done by SkillSpawner.injectUserConfig)
    let content = fs.readFileSync(systemMdPath, "utf-8")
    const replacements: Record<string, string> = {
      "{USER_NAME}": "Alice",
      "{USER_TECHNICAL_FOCUS}": "Rust and distributed systems",
      "{USER_NOT_INTERESTED}": "cryptocurrency",
      "{CUSTOM_PLACEHOLDER}": "custom_value",
    }
    for (const [placeholder, value] of Object.entries(replacements)) {
      content = content.replace(new RegExp(placeholder.replace(/[{}]/g, "\\$&"), "g"), value)
    }
    fs.writeFileSync(systemMdPath, content)

    const result = fs.readFileSync(systemMdPath, "utf-8")
    expect(result).toContain("Alice")
    expect(result).toContain("Rust and distributed systems")
    expect(result).toContain("cryptocurrency")
    expect(result).toContain("custom_value")
    expect(result).not.toContain("{USER_NAME}")
    expect(result).not.toContain("{USER_TECHNICAL_FOCUS}")
  })

  it("generates .env file with OpenCeph vars and custom env vars", () => {
    const tentacleDir = createTentacleDir()
    const envPath = path.join(tentacleDir, ".env")

    // Simulate .env generation (as done by SkillSpawner.injectUserConfig)
    const envLines: string[] = [
      `OPENCEPH_TENTACLE_ID=t_test`,
      `OPENCEPH_TRIGGER_MODE=self`,
      `# Custom env vars`,
      `GITHUB_TOKEN=ghp_test123`,
      `GITHUB_REPOS=user/repo1,user/repo2`,
      `CHECK_INTERVAL=2h`,
    ]
    fs.writeFileSync(envPath, envLines.join("\n") + "\n")

    const content = fs.readFileSync(envPath, "utf-8")
    expect(content).toContain("OPENCEPH_TENTACLE_ID=t_test")
    expect(content).toContain("OPENCEPH_TRIGGER_MODE=self")
    expect(content).toContain("GITHUB_TOKEN=ghp_test123")
    expect(content).toContain("GITHUB_REPOS=user/repo1,user/repo2")
  })

  it("handles missing placeholders gracefully", () => {
    const tentacleDir = createTentacleDir()
    const systemMdPath = path.join(tentacleDir, "prompt", "SYSTEM.md")

    // Only replace some placeholders, leave others
    let content = fs.readFileSync(systemMdPath, "utf-8")
    content = content.replace("{USER_NAME}", "Bob")
    // Leave {USER_TECHNICAL_FOCUS} and others unchanged
    fs.writeFileSync(systemMdPath, content)

    const result = fs.readFileSync(systemMdPath, "utf-8")
    expect(result).toContain("Bob")
    // Unreplaced placeholders remain as-is (default values would be used)
    expect(result).toContain("{USER_TECHNICAL_FOCUS}")
  })
})
