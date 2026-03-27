import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { getBuiltinTentaclesDir, initBuiltinTentacles, upgradeBuiltinTentacles } from "../../src/cli.js"

describe("builtin tentacle install and upgrade", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-builtin-install-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("installs all builtin tentacles into the target directory", async () => {
    await initBuiltinTentacles(dir)
    const installed = fs.readdirSync(dir).sort()
    const source = fs.readdirSync(getBuiltinTentaclesDir()).sort()
    expect(installed).toEqual(source)
    expect(installed).toHaveLength(10)
  })

  it("skips existing builtin tentacles on init", async () => {
    fs.mkdirSync(path.join(dir, "hn-radar"), { recursive: true })
    fs.writeFileSync(path.join(dir, "hn-radar", "custom.txt"), "keep me")

    await initBuiltinTentacles(dir)

    expect(fs.readFileSync(path.join(dir, "hn-radar", "custom.txt"), "utf-8")).toBe("keep me")
  })

  it("upgrades src and SKILL but preserves prompt customizations", async () => {
    await initBuiltinTentacles(dir)
    const installed = path.join(dir, "hn-radar")

    const skillMdPath = path.join(installed, "SKILL.md")
    const promptPath = path.join(installed, "prompt", "SYSTEM.md")
    fs.writeFileSync(promptPath, "CUSTOM PROMPT", "utf-8")
    fs.writeFileSync(skillMdPath, fs.readFileSync(skillMdPath, "utf-8").replace("version: 1.0.0", "version: 0.9.0"), "utf-8")
    fs.writeFileSync(path.join(installed, "src", "main.py"), "print('old')\n", "utf-8")

    await upgradeBuiltinTentacles(dir)

    expect(fs.readFileSync(promptPath, "utf-8")).toBe("CUSTOM PROMPT")
    expect(fs.readFileSync(skillMdPath, "utf-8")).toContain("version: 1.0.0")
    expect(fs.readFileSync(path.join(installed, "src", "main.py"), "utf-8")).not.toContain("print('old')")
    expect(fs.existsSync(path.join(installed, ".backup-0.9.0", "prompt", "SYSTEM.md"))).toBe(true)
  })
})
