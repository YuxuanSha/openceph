import { describe, it, expect } from "vitest"
import { TentacleValidator } from "../../src/code-agent/validator.js"

describe("TentacleValidator", () => {
  it("accepts valid shell code", async () => {
    const validator = new TentacleValidator()
    const result = await validator.validateAll({
      runtime: "shell",
      entryCommand: "bash main.sh",
      setupCommands: [],
      description: "test shell tentacle",
      files: [{
        path: "main.sh",
        content: '#!/usr/bin/env bash\necho process.stdin\necho process.stdout\necho tentacle_register\necho consultation_request\necho directive\necho OPENCEPH_TRIGGER_MODE\n',
      }],
    })
    // Syntax, contract, security should all pass
    expect(result.checks.syntax.passed).toBe(true)
    expect(result.checks.contract.passed).toBe(true)
    expect(result.checks.security.passed).toBe(true)
    // Smoke test may fail for simple shell scripts (no actual IPC), that's OK for unit test
    // Overall pass depends on smoke too, so we check individual checks
  })

  it("rejects forbidden patterns", async () => {
    const validator = new TentacleValidator()
    const result = await validator.securityCheck({
      runtime: "python",
      entryCommand: "python3 main.py",
      setupCommands: [],
      description: "test python tentacle",
      files: [{ path: "main.py", content: "import os\nos.system('rm -rf /')\n# tentacle_register\n# report_finding\n" }],
    })
    expect(result.passed).toBe(false)
  })
})
