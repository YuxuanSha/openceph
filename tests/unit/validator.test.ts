import { describe, it, expect } from "vitest"
import { TentacleValidator } from "../../src/code-agent/validator.js"

describe("TentacleValidator", () => {
  it("accepts valid shell code", async () => {
    const validator = new TentacleValidator()
    const result = await validator.validateAll({
      runtime: "shell",
      entryCommand: "bash main.sh",
      setupCommands: [],
      files: [{
        path: "main.sh",
        content: "#!/usr/bin/env bash\necho tentacle_register\necho report_finding\n",
      }],
    })
    expect(result.valid).toBe(true)
  })

  it("rejects forbidden patterns", async () => {
    const validator = new TentacleValidator()
    const result = await validator.securityCheck({
      runtime: "python",
      entryCommand: "python3 main.py",
      setupCommands: [],
      files: [{ path: "main.py", content: "import os\nos.system('rm -rf /')\n# tentacle_register\n# report_finding\n" }],
    })
    expect(result.valid).toBe(false)
  })
})
