import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import extract from "extract-zip"
import { initLoggers } from "../../src/logger/index.js"
import { TentaclePackager } from "../../src/skills/tentacle-packager.js"

describe("TentaclePackager", () => {
  let dir: string
  let originalHome: string | undefined

  beforeAll(() => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-packager-log-"))
    initLoggers({
      logging: { logDir: path.join(logDir, "logs"), level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    } as any)
  })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-packager-"))
    originalHome = process.env.HOME
    process.env.HOME = dir
  })

  afterEach(() => {
    process.env.HOME = originalHome
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function createMockTentacle(tentacleId: string): string {
    const tentacleDir = path.join(dir, ".openceph", "tentacles", tentacleId)
    fs.mkdirSync(path.join(tentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(tentacleDir, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(tentacleDir, "SKILL.md"),
      `---\nname: ${tentacleId}\ndescription: Test tentacle\nversion: 1.0.0\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n---\n`,
    )
    fs.writeFileSync(
      path.join(tentacleDir, "prompt", "SYSTEM.md"),
      "You are a test tentacle. Monitor and report findings to the brain.",
    )
    fs.writeFileSync(path.join(tentacleDir, "README.md"), "# Test\n\n## Environment\n\n## Deploy\n")
    fs.writeFileSync(path.join(tentacleDir, "src", "main.py"), "import sys\nprint('hello')\n")
    return tentacleDir
  }

  describe("restorePlaceholders via pack()", () => {
    it("restores placeholder values from tentacle.json mapping before packing", async () => {
      const tentacleId = "t_restore_test"
      const tentacleDir = createMockTentacle(tentacleId)

      // Simulate injected user config in SYSTEM.md
      fs.writeFileSync(
        path.join(tentacleDir, "prompt", "SYSTEM.md"),
        "Monitor the org my-github-org and use key sk-1234 for lookups.",
      )
      // Store the placeholder mapping in tentacle.json
      fs.writeFileSync(
        path.join(tentacleDir, "tentacle.json"),
        JSON.stringify({
          tentacleId,
          placeholderMapping: {
            "{GITHUB_ORG}": "my-github-org",
            "{API_KEY}": "sk-1234",
          },
        }),
      )

      const outputDir = path.join(dir, "output")
      fs.mkdirSync(outputDir, { recursive: true })

      const packager = new TentaclePackager()
      await packager.pack(tentacleId, outputDir)

      // After packing, SYSTEM.md in the tentacle dir should have placeholders restored
      const restoredContent = fs.readFileSync(path.join(tentacleDir, "prompt", "SYSTEM.md"), "utf-8")
      expect(restoredContent).toContain("{GITHUB_ORG}")
      expect(restoredContent).toContain("{API_KEY}")
      expect(restoredContent).not.toContain("my-github-org")
      expect(restoredContent).not.toContain("sk-1234")
    })
  })

  describe("pack()", () => {
    it("creates a .tentacle zip archive from a deployed tentacle", async () => {
      const tentacleId = "t_pack_test"
      createMockTentacle(tentacleId)
      const outputDir = path.join(dir, "output")
      fs.mkdirSync(outputDir, { recursive: true })

      const packager = new TentaclePackager()
      const outputPath = await packager.pack(tentacleId, outputDir)

      // Output named after skill name (same as tentacleId in this test)
      expect(outputPath).toBe(path.join(outputDir, `${tentacleId}.tentacle`))
      expect(fs.existsSync(outputPath)).toBe(true)
      const stat = fs.statSync(outputPath)
      expect(stat.size).toBeGreaterThan(0)

      // Must be a valid zip (extract-zip will throw on tar.gz)
      const verifyDir = path.join(dir, "verify")
      fs.mkdirSync(verifyDir, { recursive: true })
      await expect(extract(outputPath, { dir: verifyDir })).resolves.not.toThrow()
    })

    it("throws when tentacle directory does not exist", async () => {
      const packager = new TentaclePackager()
      await expect(packager.pack("nonexistent_tentacle")).rejects.toThrow("not found")
    })

    it("excludes runtime artifacts like venv/ and node_modules/", async () => {
      const tentacleId = "t_pack_exclude"
      const tentacleDir = createMockTentacle(tentacleId)

      fs.mkdirSync(path.join(tentacleDir, "venv", "lib"), { recursive: true })
      fs.writeFileSync(path.join(tentacleDir, "venv", "lib", "python.py"), "# venv")
      fs.mkdirSync(path.join(tentacleDir, "node_modules", "pkg"), { recursive: true })
      fs.writeFileSync(path.join(tentacleDir, "node_modules", "pkg", "index.js"), "// node")
      fs.writeFileSync(path.join(tentacleDir, ".env"), "SECRET=xyz")
      fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), '{"tentacleId": "t_pack_exclude"}')

      const outputDir = path.join(dir, "output")
      fs.mkdirSync(outputDir, { recursive: true })

      const packager = new TentaclePackager()
      const outputPath = await packager.pack(tentacleId, outputDir)
      expect(fs.existsSync(outputPath)).toBe(true)

      const extractDir = path.join(dir, "extracted")
      fs.mkdirSync(extractDir, { recursive: true })
      await extract(outputPath, { dir: extractDir })

      const extractedBase = path.join(extractDir, tentacleId)
      expect(fs.existsSync(path.join(extractedBase, "src", "main.py"))).toBe(true)
      expect(fs.existsSync(path.join(extractedBase, "SKILL.md"))).toBe(true)
      expect(fs.existsSync(path.join(extractedBase, "venv"))).toBe(false)
      expect(fs.existsSync(path.join(extractedBase, "node_modules"))).toBe(false)
      expect(fs.existsSync(path.join(extractedBase, ".env"))).toBe(false)
      expect(fs.existsSync(path.join(extractedBase, "tentacle.json"))).toBe(false)
    })
  })

  describe("install()", () => {
    it("installs from a local directory", async () => {
      const sourceDir = path.join(dir, "source-skill")
      fs.mkdirSync(path.join(sourceDir, "src"), { recursive: true })
      fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "---\nname: source-skill\n---\n")
      fs.writeFileSync(path.join(sourceDir, "src", "main.py"), "print('installed')\n")

      const packager = new TentaclePackager()
      const targetDir = await packager.install(sourceDir)

      expect(targetDir).toBe(path.join(dir, ".openceph", "skills", "source-skill"))
      expect(fs.existsSync(targetDir)).toBe(true)
      expect(fs.existsSync(path.join(targetDir, "SKILL.md"))).toBe(true)
      expect(fs.existsSync(path.join(targetDir, "src", "main.py"))).toBe(true)
    })

    it("throws for unsupported source format", async () => {
      const packager = new TentaclePackager()
      await expect(packager.install("ftp://invalid.source")).rejects.toThrow()
    })
  })

  describe("listInstalled()", () => {
    it("returns empty array when skills directory does not exist", async () => {
      const packager = new TentaclePackager()
      const list = await packager.listInstalled()
      expect(list).toEqual([])
    })

    it("lists installed skills and detects skill_tentacles", async () => {
      const skillsDir = path.join(dir, ".openceph", "skills")

      const tentacleSkillDir = path.join(skillsDir, "full-tentacle")
      fs.mkdirSync(path.join(tentacleSkillDir, "prompt"), { recursive: true })
      fs.mkdirSync(path.join(tentacleSkillDir, "src"), { recursive: true })
      fs.writeFileSync(path.join(tentacleSkillDir, "SKILL.md"), "---\nname: full-tentacle\n---\n")
      fs.writeFileSync(path.join(tentacleSkillDir, "prompt", "SYSTEM.md"), "system prompt")
      fs.writeFileSync(path.join(tentacleSkillDir, "README.md"), "# readme\n")
      fs.writeFileSync(path.join(tentacleSkillDir, "src", "main.py"), "print('hi')\n")

      const partialDir = path.join(skillsDir, "partial-skill")
      fs.mkdirSync(partialDir, { recursive: true })
      fs.writeFileSync(path.join(partialDir, "SKILL.md"), "---\nname: partial\n---\n")

      const packager = new TentaclePackager()
      const list = await packager.listInstalled()

      expect(list).toHaveLength(2)

      const full = list.find((s) => s.name === "full-tentacle")
      expect(full).toBeDefined()
      expect(full!.isSkillTentacle).toBe(true)

      const partial = list.find((s) => s.name === "partial-skill")
      expect(partial).toBeDefined()
      expect(partial!.isSkillTentacle).toBe(false)
    })
  })

  describe("info()", () => {
    it("returns rich info for an installed skill_tentacle", async () => {
      const skillsDir = path.join(dir, ".openceph", "skills")
      const skillDir = path.join(skillsDir, "info-test")
      fs.mkdirSync(path.join(skillDir, "prompt"), { recursive: true })
      fs.mkdirSync(path.join(skillDir, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: info-test\ndescription: A test skill tentacle\nversion: 2.0.0\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n      capabilities: [api_integration, llm_reasoning]\n      requires:\n        bins: [python3]\n        env: [OPENAI_API_KEY]\n---\n",
      )
      fs.writeFileSync(path.join(skillDir, "prompt", "SYSTEM.md"), "# Identity\nYou are info-test.\n\n# Mission\nTest the info method thoroughly.")
      fs.writeFileSync(path.join(skillDir, "README.md"), "# readme\n")
      fs.writeFileSync(path.join(skillDir, "src", "main.py"), "print('hi')\n")

      const packager = new TentaclePackager()
      const info = await packager.info("info-test")

      expect(info).not.toBeNull()
      expect(info!.name).toBe("info-test")
      expect(info!.description).toBe("A test skill tentacle")
      expect(info!.version).toBe("2.0.0")
      expect(info!.isSkillTentacle).toBe(true)
      expect(info!.runtime).toBe("python")
      expect(info!.requires).toBeDefined()
      expect((info!.requires as any).bins).toContain("python3")
      expect((info!.requires as any).env).toContain("OPENAI_API_KEY")
      expect(info!.capabilities).toBeDefined()
      expect((info!.capabilities as any).daemon).toBeInstanceOf(Array)
      expect((info!.capabilities as any).consultation).toBeDefined()
      expect(info!.customizable).toBeInstanceOf(Array)
      expect(typeof info!.path).toBe("string")
    })

    it("returns rich info with customizable fields", async () => {
      const skillsDir = path.join(dir, ".openceph", "skills")
      const skillDir = path.join(skillsDir, "custom-test")
      fs.mkdirSync(path.join(skillDir, "prompt"), { recursive: true })
      fs.mkdirSync(path.join(skillDir, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: custom-test\ndescription: Customizable skill\nversion: 1.0.0\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n      customizable:\n        - field: GITHUB_ORG\n          description: Target GitHub org\n          env_var: GITHUB_ORG\n---\n",
      )
      fs.writeFileSync(path.join(skillDir, "prompt", "SYSTEM.md"), "# Identity\nYou are custom-test.\n\n# Mission\nTest customizable fields.")
      fs.writeFileSync(path.join(skillDir, "README.md"), "# readme\n")
      fs.writeFileSync(path.join(skillDir, "src", "main.py"), "print('hi')\n")

      const packager = new TentaclePackager()
      const info = await packager.info("custom-test")

      expect(info).not.toBeNull()
      const customizable = info!.customizable as Array<{ field: string; description: string; type: string }>
      expect(customizable.length).toBeGreaterThan(0)
      expect(customizable[0].field).toBe("GITHUB_ORG")
      expect(customizable[0].description).toBe("Target GitHub org")
      expect(customizable[0].type).toBe("env_var")
    })

    it("parses block-list metadata in SKILL.md", async () => {
      const skillsDir = path.join(dir, ".openceph", "skills")
      const skillDir = path.join(skillsDir, "block-list-test")
      fs.mkdirSync(path.join(skillDir, "prompt"), { recursive: true })
      fs.mkdirSync(path.join(skillDir, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: block-list-test\ndescription: Block list parsing\nversion: 1.2.3\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n      capabilities:\n        daemon:\n          - api_integration\n          - llm_reasoning\n        agent: []\n        consultation:\n          mode: batch\n          batchThreshold: 5\n      requires:\n        bins:\n          - python3\n        env:\n          - OPENROUTER_API_KEY\n      customizable:\n        - field: WATCH_TOPIC\n          description: Topic to watch\n          prompt_placeholder: '{WATCH_TOPIC}'\n---\n",
      )
      fs.writeFileSync(path.join(skillDir, "prompt", "SYSTEM.md"), "# Identity\nYou are block-list-test.\n\n# Mission\nTest block list parsing.")
      fs.writeFileSync(path.join(skillDir, "README.md"), "# readme\n")
      fs.writeFileSync(path.join(skillDir, "src", "main.py"), "print('hi')\n")

      const packager = new TentaclePackager()
      const info = await packager.info("block-list-test")

      expect(info).not.toBeNull()
      expect((info!.requires as any).bins).toContain("python3")
      expect((info!.requires as any).env).toContain("OPENROUTER_API_KEY")
      expect((info!.capabilities as any).daemon).toEqual(["api_integration", "llm_reasoning"])
      expect((info!.capabilities as any).consultation).toEqual({ mode: "batch", batchThreshold: 5 })
      expect((info!.customizable as Array<{ type: string }>)[0]?.type).toBe("prompt_placeholder")
    })

    it("returns null for a nonexistent skill", async () => {
      fs.mkdirSync(path.join(dir, ".openceph", "skills"), { recursive: true })

      const packager = new TentaclePackager()
      const info = await packager.info("nonexistent")
      expect(info).toBeNull()
    })
  })
})
