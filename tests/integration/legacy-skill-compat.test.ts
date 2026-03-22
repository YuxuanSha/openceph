import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { SkillLoader } from "../../src/skills/skill-loader.js"
import { SkillInspector } from "../../src/skills/skill-inspector.js"
import { initLoggers } from "../../src/logger/index.js"

describe("integration: legacy skill compatibility", () => {
  let dir: string
  let logDir: string

  beforeAll(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-legacy-log-"))
    initLoggers({
      logging: { logDir, level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    } as any)
  })

  afterAll(() => {
    fs.rmSync(logDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-legacy-compat-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("detects legacy spawnable SKILL as spawnable but not skill_tentacle", async () => {
    const skillDir = path.join(dir, "legacy-monitor")
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: legacy-monitor
description: Monitor something
version: 1.0.0
spawnable: true
runtime: python
entry: scripts/monitor.py
default_trigger: every 6 hours
---
# Legacy Monitor
Monitors something useful.
`)
    fs.writeFileSync(path.join(skillDir, "scripts", "monitor.py"), "# legacy monitor script\n")

    const loader = new SkillLoader([dir])
    const skills = await loader.loadAll()
    const skill = skills.find(s => s.name === "legacy-monitor")

    expect(skill).toBeDefined()
    expect(skill!.spawnable).toBe(true)
    expect(skill!.isSkillTentacle).toBe(false)
    expect(skill!.skillTentacleConfig).toBeUndefined()
  })

  it("detects skill_tentacle with metadata.openceph.tentacle", async () => {
    const skillDir = path.join(dir, "new-monitor")
    fs.mkdirSync(path.join(skillDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(skillDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: new-monitor
description: Monitor something new
version: 1.0.0
metadata:
  openceph:
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: self
      setup_commands:
        - pip install -r src/requirements.txt
      requires:
        bins:
          - python3
        env: []
      capabilities:
        - web_fetch
---
# New Monitor
`)
    fs.writeFileSync(path.join(skillDir, "README.md"), "# Deploy\n## Environment\n## Steps\n")
    fs.writeFileSync(path.join(skillDir, "prompt", "SYSTEM.md"), "# Identity\nYou are a new monitor.\n\n# Mission\nMonitor something new.")
    fs.writeFileSync(path.join(skillDir, "src", "main.py"), "# main\n")

    const loader = new SkillLoader([dir])
    const skills = await loader.loadAll()
    const skill = skills.find(s => s.name === "new-monitor")

    expect(skill).toBeDefined()
    expect(skill!.spawnable).toBe(true)
    expect(skill!.isSkillTentacle).toBe(true)
    expect(skill!.skillTentacleConfig).toBeDefined()
    expect(skill!.skillTentacleConfig!.runtime).toBe("python")
  })

  it("SkillInspector.isSkillTentacle differentiates correctly", async () => {
    // Legacy skill — no prompt/SYSTEM.md, no src/, no README.md
    const legacyDir = path.join(dir, "legacy")
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, "SKILL.md"), `---
name: legacy
spawnable: true
runtime: python
---
# Legacy
`)

    // New skill_tentacle — has all required structure
    const newDir = path.join(dir, "new-st")
    fs.mkdirSync(path.join(newDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(newDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(newDir, "SKILL.md"), `---
name: new-st
metadata:
  openceph:
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
---
`)
    fs.writeFileSync(path.join(newDir, "README.md"), "# Deploy\n")
    fs.writeFileSync(path.join(newDir, "prompt", "SYSTEM.md"), "# Identity\nTest tentacle system prompt content here for validation.")
    fs.writeFileSync(path.join(newDir, "src", "main.py"), "# main\n")

    expect(await SkillInspector.isSkillTentacle(legacyDir)).toBe(false)
    expect(await SkillInspector.isSkillTentacle(newDir)).toBe(true)
  })

  it("both legacy and skill_tentacle coexist in same skills dir", async () => {
    // Create legacy skill
    const legacyDir = path.join(dir, "legacy-rss")
    fs.mkdirSync(path.join(legacyDir, "scripts"), { recursive: true })
    fs.writeFileSync(path.join(legacyDir, "SKILL.md"), `---
name: legacy-rss
description: RSS monitor (legacy)
version: 1.0.0
spawnable: true
runtime: python
entry: scripts/main.py
---
# Legacy RSS
`)
    fs.writeFileSync(path.join(legacyDir, "scripts", "main.py"), "# rss\n")

    // Create skill_tentacle
    const stDir = path.join(dir, "new-rss")
    fs.mkdirSync(path.join(stDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(stDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(stDir, "SKILL.md"), `---
name: new-rss
description: RSS monitor (skill_tentacle)
version: 1.0.0
metadata:
  openceph:
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: self
      setup_commands: []
      requires:
        bins: []
        env: []
      capabilities: []
---
# New RSS
`)
    fs.writeFileSync(path.join(stDir, "README.md"), "# Deploy\n## Env\n")
    fs.writeFileSync(path.join(stDir, "prompt", "SYSTEM.md"), "# Identity\nRSS tentacle.\n\n# Mission\nMonitor RSS feeds.")
    fs.writeFileSync(path.join(stDir, "src", "main.py"), "# main\n")

    const loader = new SkillLoader([dir])
    const skills = await loader.loadAll()

    const legacy = skills.find(s => s.name === "legacy-rss")
    const newSt = skills.find(s => s.name === "new-rss")

    expect(legacy).toBeDefined()
    expect(legacy!.spawnable).toBe(true)
    expect(legacy!.isSkillTentacle).toBe(false)

    expect(newSt).toBeDefined()
    expect(newSt!.spawnable).toBe(true)
    expect(newSt!.isSkillTentacle).toBe(true)
  })
})
