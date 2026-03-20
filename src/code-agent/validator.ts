import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { GeneratedCode } from "./code-agent.js"

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export class TentacleValidator {
  async syntaxCheck(code: GeneratedCode): Promise<ValidationResult> {
    const dir = await materialize(code)
    try {
      if (code.runtime === "python") {
        await run("python3", ["-m", "py_compile", path.join(dir, "main.py")], dir)
      } else if (code.runtime === "typescript") {
        await run("npx", ["tsc", "--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext", path.join(dir, "src/main.ts")], dir)
      } else if (code.runtime === "go") {
        await run("go", ["build", path.join(dir, "main.go")], dir)
      } else if (code.runtime === "shell") {
        await run("bash", ["-n", path.join(dir, "main.sh")], dir)
      }
      return { valid: true, errors: [], warnings: [] }
    } catch (error) {
      return { valid: false, errors: [error instanceof Error ? error.message : String(error)], warnings: [] }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  async contractCheck(code: GeneratedCode): Promise<ValidationResult> {
    const aggregate = code.files.map((file) => file.content).join("\n")
    const errors: string[] = []
    if (!aggregate.includes("tentacle_register")) {
      errors.push("missing tentacle_register")
    }
    if (!aggregate.includes("report_finding") && !aggregate.includes("consultation_request")) {
      errors.push("missing report_finding or consultation_request")
    }
    return { valid: errors.length === 0, errors, warnings: [] }
  }

  async securityCheck(code: GeneratedCode): Promise<ValidationResult> {
    const aggregate = code.files.map((file) => file.content).join("\n")
    const banned = ["os.system(", "subprocess.Popen", "eval(", "exec("]
    const matches = banned.filter((token) => aggregate.includes(token))
    return {
      valid: matches.length === 0,
      errors: matches.map((token) => `forbidden token: ${token}`),
      warnings: [],
    }
  }

  async sandboxTest(code: GeneratedCode): Promise<ValidationResult> {
    return {
      valid: true,
      errors: [],
      warnings: ["sandboxTest is lightweight in Week 3 and does not execute long-running tentacles"],
    }
  }

  async validateAll(code: GeneratedCode): Promise<ValidationResult> {
    const stages = await Promise.all([
      this.syntaxCheck(code),
      this.contractCheck(code),
      this.securityCheck(code),
      this.sandboxTest(code),
    ])
    const errors = stages.flatMap((stage) => stage.errors)
    const warnings = stages.flatMap((stage) => stage.warnings)
    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }
}

async function materialize(code: GeneratedCode): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openceph-code-agent-"))
  for (const file of code.files) {
    const fullPath = path.join(dir, file.path)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, file.content, "utf-8")
  }
  return dir
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message))
      } else {
        resolve()
      }
    })
  })
}
