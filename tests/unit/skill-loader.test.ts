import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { SkillLoader } from "../../src/skills/skill-loader.js"

describe("SkillLoader", () => {
  let base1: string
  let base2: string

  beforeEach(() => {
    base1 = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-skill-a-"))
    base2 = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-skill-b-"))
    fs.mkdirSync(path.join(base1, "demo"), { recursive: true })
    fs.mkdirSync(path.join(base2, "demo"), { recursive: true })
    fs.writeFileSync(path.join(base1, "demo", "SKILL.md"), "---\nname: demo\ndescription: lower priority\nversion: 1.0.0\nspawnable: false\n---\n")
    fs.writeFileSync(path.join(base2, "demo", "SKILL.md"), "---\nname: demo\ndescription: higher priority\nversion: 1.0.1\nspawnable: true\n---\n")
  })

  afterEach(() => {
    fs.rmSync(base1, { recursive: true, force: true })
    fs.rmSync(base2, { recursive: true, force: true })
  })

  it("prefers earlier configured paths", async () => {
    const loader = new SkillLoader([base2, base1])
    const skills = await loader.loadAll()
    expect(skills).toHaveLength(1)
    expect(skills[0].description).toBe("higher priority")
    expect(skills[0].spawnable).toBe(true)
  })
})
