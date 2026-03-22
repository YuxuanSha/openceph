import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { TentaclePackager } from "../../src/skills/tentacle-packager.js"
import { initLoggers } from "../../src/logger/index.js"

describe("integration: pack → install roundtrip", () => {
  let dir: string
  let packager: TentaclePackager

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-pack-roundtrip-"))
    packager = new TentaclePackager()
    initLoggers({
      logging: { logDir: path.join(dir, "logs"), level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    } as any)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function createMockTentacle(tentacleId: string): string {
    const tentacleDir = path.join(dir, "tentacles", tentacleId)
    fs.mkdirSync(path.join(tentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(tentacleDir, "src"), { recursive: true })
    fs.mkdirSync(path.join(tentacleDir, "docs"), { recursive: true })

    fs.writeFileSync(path.join(tentacleDir, "SKILL.md"), `---
name: ${tentacleId}
description: Test tentacle
version: 1.0.0
metadata:
  openceph:
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
---
# ${tentacleId}
`)
    fs.writeFileSync(path.join(tentacleDir, "README.md"), "# Deploy Guide\n## Environment\n## Steps\n")
    fs.writeFileSync(path.join(tentacleDir, "prompt", "SYSTEM.md"), "# Identity\nYou are a test tentacle.\n\n# Mission\nPerform roundtrip packaging test.")
    fs.writeFileSync(path.join(tentacleDir, "src", "main.py"), "print('hello')\n")
    fs.writeFileSync(path.join(tentacleDir, "src", "requirements.txt"), "# no deps\n")
    fs.writeFileSync(path.join(tentacleDir, "docs", "api.md"), "# API Reference\n")

    // Create tentacle.json (should be excluded from pack)
    fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), JSON.stringify({ id: tentacleId }))

    return tentacleDir
  }

  it("packs and installs with all files preserved", async () => {
    const tentacleId = "t_roundtrip_test"
    const tentacleDir = createMockTentacle(tentacleId)

    // Override homedir for packager
    const originalHome = process.env.HOME
    const fakeHome = path.join(dir, "fakehome")
    fs.mkdirSync(path.join(fakeHome, ".openceph", "tentacles"), { recursive: true })
    fs.mkdirSync(path.join(fakeHome, ".openceph", "skills"), { recursive: true })

    // Copy tentacle to fake home
    fs.cpSync(tentacleDir, path.join(fakeHome, ".openceph", "tentacles", tentacleId), { recursive: true })

    process.env.HOME = fakeHome
    try {
      // Pack
      const outputDir = path.join(dir, "output")
      fs.mkdirSync(outputDir, { recursive: true })
      const archivePath = await packager.pack(tentacleId, outputDir)
      expect(fs.existsSync(archivePath)).toBe(true)

      // Install
      const installDir = await packager.install(archivePath)
      expect(fs.existsSync(installDir)).toBe(true)

      // Verify files exist in installed location
      expect(fs.existsSync(path.join(installDir, "SKILL.md"))).toBe(true)
      expect(fs.existsSync(path.join(installDir, "README.md"))).toBe(true)
      expect(fs.existsSync(path.join(installDir, "prompt", "SYSTEM.md"))).toBe(true)
      expect(fs.existsSync(path.join(installDir, "src", "main.py"))).toBe(true)
      expect(fs.existsSync(path.join(installDir, "docs", "api.md"))).toBe(true)

      // Verify tentacle.json was excluded
      expect(fs.existsSync(path.join(installDir, "tentacle.json"))).toBe(false)

      // Verify content preserved
      const skillMd = fs.readFileSync(path.join(installDir, "SKILL.md"), "utf-8")
      expect(skillMd).toContain("spawnable: true")
    } finally {
      process.env.HOME = originalHome
    }
  })

  it("installs from local directory", async () => {
    const tentacleId = "t_local_install"
    const tentacleDir = createMockTentacle(tentacleId)

    const originalHome = process.env.HOME
    const fakeHome = path.join(dir, "fakehome2")
    fs.mkdirSync(path.join(fakeHome, ".openceph", "skills"), { recursive: true })

    process.env.HOME = fakeHome
    try {
      const installDir = await packager.install(tentacleDir)
      expect(fs.existsSync(installDir)).toBe(true)
      expect(fs.existsSync(path.join(installDir, "SKILL.md"))).toBe(true)
      expect(fs.existsSync(path.join(installDir, "src", "main.py"))).toBe(true)
    } finally {
      process.env.HOME = originalHome
    }
  })
})
