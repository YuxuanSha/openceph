import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { SkillLoader } from "../../src/skills/skill-loader.js"
import { initLoggers } from "../../src/logger/index.js"

describe("Customizable fields parsing", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-custom-fields-"))
    initLoggers({
      logging: { logDir: path.join(dir, "logs"), level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    } as any)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function createSkillDir(name: string, skillMdContent: string, extraFiles?: Record<string, string>) {
    const skillDir = path.join(dir, name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMdContent)
    if (extraFiles) {
      for (const [relPath, content] of Object.entries(extraFiles)) {
        const fullPath = path.join(skillDir, relPath)
        fs.mkdirSync(path.dirname(fullPath), { recursive: true })
        fs.writeFileSync(fullPath, content)
      }
    }
  }

  it("parses skill_tentacle with customizable fields", async () => {
    createSkillDir("test-skill", `---
name: test-skill
description: Test skill with customizable fields
version: 1.0.0
metadata:
  openceph:
    emoji: 🧪
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: self
      setup_commands:
        - pip install -r requirements.txt
      requires:
        bins:
          - python3
        env:
          - MY_API_KEY
      capabilities:
        - web_fetch
      customizable:
        - field: api_key
          description: API Key
          env_var: MY_API_KEY
          default: ""
        - field: user_name
          description: User name
          prompt_placeholder: "{USER_NAME}"
          default: "User"
---
# Test Skill
`, {
      "README.md": "# Test\n## Environment\n## Deploy\n",
      "prompt/SYSTEM.md": "# Identity\nYou are a test tentacle for {USER_NAME}.\n\n# Mission\nTest customizable field injection thoroughly.",
      "src/main.py": "# placeholder\n",
    })

    const loader = new SkillLoader([dir])
    const skills = await loader.loadAll()
    const skill = skills.find(s => s.name === "test-skill")

    expect(skill).toBeDefined()
    expect(skill!.isSkillTentacle).toBe(true)
    expect(skill!.skillTentacleConfig).toBeDefined()
    expect(skill!.skillTentacleConfig!.spawnable).toBe(true)
    expect(skill!.skillTentacleConfig!.runtime).toBe("python")
    expect(skill!.skillTentacleConfig!.customizable).toBeDefined()
    expect(skill!.skillTentacleConfig!.customizable!.length).toBe(2)

    const envVarField = skill!.skillTentacleConfig!.customizable!.find(f => f.field === "api_key")
    expect(envVarField).toBeDefined()
    expect(envVarField!.envVar).toBe("MY_API_KEY")

    const placeholderField = skill!.skillTentacleConfig!.customizable!.find(f => f.field === "user_name")
    expect(placeholderField).toBeDefined()
    expect(placeholderField!.promptPlaceholder).toBe("{USER_NAME}")
  })

  it("detects non-skill_tentacle (no tentacle metadata)", async () => {
    createSkillDir("legacy-skill", `---
name: legacy-skill
description: Legacy spawnable skill
version: 1.0.0
spawnable: true
runtime: python
entry: scripts/main.py
---
# Legacy Skill
`)

    const loader = new SkillLoader([dir])
    const skills = await loader.loadAll()
    const skill = skills.find(s => s.name === "legacy-skill")

    expect(skill).toBeDefined()
    expect(skill!.isSkillTentacle).toBe(false)
    expect(skill!.skillTentacleConfig).toBeUndefined()
  })

  it("detects skill_tentacle with all required files", async () => {
    createSkillDir("full-skill", `---
name: full-skill
description: Full skill_tentacle
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
# Full Skill
`, {
      "README.md": "# Full\n## Env\n## Deploy\n",
      "prompt/SYSTEM.md": "# Identity\nYou are a full skill_tentacle.\n\n# Mission\nTest full detection flow.",
      "src/main.py": "# main\n",
    })

    const loader = new SkillLoader([dir])
    const skills = await loader.loadAll()
    const skill = skills.find(s => s.name === "full-skill")

    expect(skill).toBeDefined()
    expect(skill!.isSkillTentacle).toBe(true)
  })
})
