import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { SkillInspector } from "../../src/skills/skill-inspector.js"

describe("SkillInspector — skill_tentacle detection", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-inspector-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function createValidSkillTentacle(base: string): void {
    fs.mkdirSync(path.join(base, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(base, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(base, "SKILL.md"),
      `---
name: test-tentacle
description: A test skill tentacle
version: 1.0.0
metadata:
  openceph:
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: 30m
---
# Test Tentacle
`,
    )
    fs.writeFileSync(
      path.join(base, "prompt", "SYSTEM.md"),
      "You are a test tentacle. " +
        "Your job is to monitor things and report findings back to the brain. " +
        "This prompt is long enough to pass the 50-character minimum check.",
    )
    fs.writeFileSync(path.join(base, "README.md"), "# Test\n\n## Environment\n\n## Deploy\n\n## Start\n")
    fs.writeFileSync(path.join(base, "src", "main.py"), "print('hello')\n")
  }

  describe("isSkillTentacle()", () => {
    it("returns true for a valid skill_tentacle directory", () => {
      const skillPath = path.join(dir, "valid-tentacle")
      fs.mkdirSync(skillPath)
      createValidSkillTentacle(skillPath)

      expect(SkillInspector.isSkillTentacle(skillPath)).toBe(true)
    })

    it("returns false when SKILL.md is missing", () => {
      const skillPath = path.join(dir, "no-skill-md")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.mkdirSync(path.join(skillPath, "prompt"), { recursive: true })
      fs.mkdirSync(path.join(skillPath, "src"), { recursive: true })
      fs.writeFileSync(path.join(skillPath, "prompt", "SYSTEM.md"), "system prompt content here that is long enough")
      fs.writeFileSync(path.join(skillPath, "README.md"), "# readme\n")

      expect(SkillInspector.isSkillTentacle(skillPath)).toBe(false)
    })

    it("returns false when prompt/SYSTEM.md is missing", () => {
      const skillPath = path.join(dir, "no-system-md")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.mkdirSync(path.join(skillPath, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(skillPath, "SKILL.md"),
        "---\nname: test\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n---\n",
      )
      fs.writeFileSync(path.join(skillPath, "README.md"), "# readme\n")

      expect(SkillInspector.isSkillTentacle(skillPath)).toBe(false)
    })

    it("returns false when src/ is missing", () => {
      const skillPath = path.join(dir, "no-src")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.mkdirSync(path.join(skillPath, "prompt"), { recursive: true })
      fs.writeFileSync(
        path.join(skillPath, "SKILL.md"),
        "---\nname: test\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n---\n",
      )
      fs.writeFileSync(path.join(skillPath, "prompt", "SYSTEM.md"), "system prompt")
      fs.writeFileSync(path.join(skillPath, "README.md"), "# readme\n")

      expect(SkillInspector.isSkillTentacle(skillPath)).toBe(false)
    })

    it("returns false when README.md is missing", () => {
      const skillPath = path.join(dir, "no-readme")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.mkdirSync(path.join(skillPath, "prompt"), { recursive: true })
      fs.mkdirSync(path.join(skillPath, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(skillPath, "SKILL.md"),
        "---\nname: test\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n---\n",
      )
      fs.writeFileSync(path.join(skillPath, "prompt", "SYSTEM.md"), "system prompt")

      expect(SkillInspector.isSkillTentacle(skillPath)).toBe(false)
    })

    it("returns false when spawnable is not set in metadata.openceph.tentacle", () => {
      const skillPath = path.join(dir, "not-spawnable")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.mkdirSync(path.join(skillPath, "prompt"), { recursive: true })
      fs.mkdirSync(path.join(skillPath, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(skillPath, "SKILL.md"),
        "---\nname: test\nmetadata:\n  openceph:\n    tentacle:\n      runtime: python\n---\n",
      )
      fs.writeFileSync(path.join(skillPath, "prompt", "SYSTEM.md"), "system prompt")
      fs.writeFileSync(path.join(skillPath, "README.md"), "# readme\n")

      expect(SkillInspector.isSkillTentacle(skillPath)).toBe(false)
    })

    it("returns false for a nonexistent path", () => {
      expect(SkillInspector.isSkillTentacle(path.join(dir, "nonexistent"))).toBe(false)
    })
  })

  describe("validateSkillTentacle()", () => {
    it("passes for a valid skill_tentacle directory", async () => {
      const skillPath = path.join(dir, "valid")
      fs.mkdirSync(skillPath)
      createValidSkillTentacle(skillPath)

      const result = await SkillInspector.validateSkillTentacle(skillPath)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("reports error when SKILL.md is missing", async () => {
      const skillPath = path.join(dir, "no-skill")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.mkdirSync(path.join(skillPath, "prompt"), { recursive: true })
      fs.mkdirSync(path.join(skillPath, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(skillPath, "prompt", "SYSTEM.md"),
        "You are a test tentacle with a sufficiently long system prompt to pass validation.",
      )
      fs.writeFileSync(path.join(skillPath, "README.md"), "# readme\n")

      const result = await SkillInspector.validateSkillTentacle(skillPath)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.message.includes("SKILL.md"))).toBe(true)
    })

    it("reports error when prompt/SYSTEM.md is too short", async () => {
      const skillPath = path.join(dir, "short-system")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.mkdirSync(path.join(skillPath, "prompt"), { recursive: true })
      fs.mkdirSync(path.join(skillPath, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(skillPath, "SKILL.md"),
        "---\nname: test\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n---\n",
      )
      fs.writeFileSync(path.join(skillPath, "prompt", "SYSTEM.md"), "too short")
      fs.writeFileSync(path.join(skillPath, "README.md"), "# readme\n")
      fs.writeFileSync(path.join(skillPath, "src", "main.py"), "print('hi')\n")

      const result = await SkillInspector.validateSkillTentacle(skillPath)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.message.includes("SYSTEM.md") && e.message.includes("50"))).toBe(true)
    })

    it("reports error when src/ directory is missing", async () => {
      const skillPath = path.join(dir, "no-src")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.mkdirSync(path.join(skillPath, "prompt"), { recursive: true })
      fs.writeFileSync(
        path.join(skillPath, "SKILL.md"),
        "---\nname: test\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n---\n",
      )
      fs.writeFileSync(
        path.join(skillPath, "prompt", "SYSTEM.md"),
        "You are a test tentacle with a sufficiently long system prompt to pass validation.",
      )
      fs.writeFileSync(path.join(skillPath, "README.md"), "# readme\n")

      const result = await SkillInspector.validateSkillTentacle(skillPath)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.message.includes("src/"))).toBe(true)
    })

    it("reports error when metadata.openceph.tentacle.spawnable is missing", async () => {
      const skillPath = path.join(dir, "no-spawnable")
      fs.mkdirSync(skillPath, { recursive: true })
      fs.mkdirSync(path.join(skillPath, "prompt"), { recursive: true })
      fs.mkdirSync(path.join(skillPath, "src"), { recursive: true })
      fs.writeFileSync(
        path.join(skillPath, "SKILL.md"),
        "---\nname: test\nmetadata:\n  openceph:\n    tentacle:\n      runtime: python\n---\n",
      )
      fs.writeFileSync(
        path.join(skillPath, "prompt", "SYSTEM.md"),
        "You are a test tentacle with a sufficiently long system prompt to pass validation.",
      )
      fs.writeFileSync(path.join(skillPath, "README.md"), "# readme\n")
      fs.writeFileSync(path.join(skillPath, "src", "main.py"), "print('hi')\n")

      const result = await SkillInspector.validateSkillTentacle(skillPath)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.message.includes("spawnable"))).toBe(true)
    })
  })
})
