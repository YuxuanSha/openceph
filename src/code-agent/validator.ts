import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import type { GeneratedCode, ValidationError } from "./code-agent.js"

export interface CheckResult {
  passed: boolean
  errors: ValidationError[]
  warnings: string[]
}

export interface ValidationResult {
  passed: boolean
  checks: {
    syntax: CheckResult
    contract: CheckResult
    security: CheckResult
    smoke: CheckResult
  }
}

export class TentacleValidator {
  async validateAll(code: GeneratedCode): Promise<ValidationResult> {
    const [syntax, contract, security] = await Promise.all([
      this.syntaxCheck(code),
      this.contractCheck(code),
      this.securityCheck(code),
    ])
    const smoke = await this.smokeTest(code)

    return {
      passed: syntax.passed && contract.passed && security.passed && smoke.passed,
      checks: { syntax, contract, security, smoke },
    }
  }

  async syntaxCheck(code: GeneratedCode): Promise<CheckResult> {
    const dir = await materialize(code)
    try {
      if (code.runtime === "python") {
        for (const file of code.files.filter((f) => f.path.endsWith(".py"))) {
          await run("python3", ["-m", "py_compile", path.join(dir, file.path)], dir)
        }
      } else if (code.runtime === "typescript") {
        const tsFiles = code.files.filter((f) => f.path.endsWith(".ts"))
        if (tsFiles.length > 0) {
          await run("npx", ["tsc", "--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext", ...tsFiles.map((f) => path.join(dir, f.path))], dir)
        }
      } else if (code.runtime === "go") {
        for (const file of code.files.filter((f) => f.path.endsWith(".go"))) {
          await run("go", ["build", path.join(dir, file.path)], dir)
        }
      } else if (code.runtime === "shell") {
        for (const file of code.files.filter((f) => f.path.endsWith(".sh"))) {
          await run("bash", ["-n", path.join(dir, file.path)], dir)
        }
      }
      return { passed: true, errors: [], warnings: [] }
    } catch (error) {
      return {
        passed: false,
        errors: [{
          check: "syntax",
          message: error instanceof Error ? error.message : String(error),
          suggestion: "Fix the syntax error in the generated code",
        }],
        warnings: [],
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  async contractCheck(code: GeneratedCode): Promise<CheckResult> {
    const aggregate = code.files.map((file) => file.content).join("\n")
    const errors: ValidationError[] = []
    const warnings: string[] = []

    // Required: connect to canonical socket env
    if (!aggregate.includes("OPENCEPH_SOCKET_PATH") && !aggregate.includes("OPENCEPH_IPC_SOCKET")) {
      errors.push({
        check: "contract",
        message: "Missing OPENCEPH_SOCKET_PATH / OPENCEPH_IPC_SOCKET connection — tentacle must connect to the IPC socket",
        suggestion: "Connect to the Unix socket specified by OPENCEPH_SOCKET_PATH (preferred) or OPENCEPH_IPC_SOCKET",
      })
    }

    // Required: send tentacle_register
    if (!aggregate.includes("tentacle_register")) {
      errors.push({
        check: "contract",
        message: "Missing tentacle_register — tentacle must register on startup",
        suggestion: "Send a tentacle_register message immediately after connecting to the IPC socket",
      })
    }

    // Required: implement consultation_request (primary reporting)
    if (!aggregate.includes("consultation_request")) {
      errors.push({
        check: "contract",
        message: "Missing consultation_request — tentacle must use consultation_request for batch reporting",
        suggestion: "Implement consultation_request as the primary reporting path",
      })
    }

    // Required: handle directive messages
    if (!aggregate.includes("directive")) {
      errors.push({
        check: "contract",
        message: "Missing directive handler — tentacle must handle pause/resume/kill directives",
        suggestion: "Add a handler for incoming directive messages (at least pause, resume, kill)",
      })
    }

    for (const action of ["pause", "resume", "kill", "run_now"]) {
      if (!aggregate.includes(action)) {
        if (code.runtime === "shell") {
          warnings.push(`Missing directive action handler: ${action}`)
          continue
        }
        errors.push({
          check: "contract",
          message: `Missing directive action handler: ${action}`,
          suggestion: `Handle directive action "${action}" explicitly`,
        })
      }
    }

    // Required: OPENCEPH_TRIGGER_MODE support
    if (!aggregate.includes("OPENCEPH_TRIGGER_MODE") && !aggregate.includes("TRIGGER_MODE")) {
      errors.push({
        check: "contract",
        message: "Missing OPENCEPH_TRIGGER_MODE handling",
        suggestion: "Read OPENCEPH_TRIGGER_MODE and support self/external execution modes",
      })
    }

    // Recommended: heartbeat_trigger handling
    if (!aggregate.includes("heartbeat_trigger") && !aggregate.includes("heartbeat_result")) {
      warnings.push("No heartbeat_trigger handler — recommended for external scheduling")
    }

    return { passed: errors.length === 0, errors, warnings }
  }

  async securityCheck(code: GeneratedCode): Promise<CheckResult> {
    const errors: ValidationError[] = []
    const warnings: string[] = []

    for (const file of code.files) {
      const content = file.content

      // Python security blacklist
      if (file.path.endsWith(".py")) {
        const pythonBanned = [
          { pattern: "os.system(", reason: "Use subprocess.run() with shell=False instead" },
          { pattern: "subprocess.Popen", reason: "Use subprocess.run() instead" },
          { pattern: "subprocess.call", reason: "Use subprocess.run() instead" },
          { pattern: "exec(", reason: "Dynamic code execution is forbidden" },
          { pattern: "eval(", reason: "Dynamic code execution is forbidden" },
          { pattern: "__import__", reason: "Dynamic imports are forbidden" },
        ]
        for (const { pattern, reason } of pythonBanned) {
          if (content.includes(pattern)) {
            errors.push({
              check: "security",
              message: `Forbidden pattern: ${pattern}`,
              file: file.path,
              suggestion: reason,
            })
          }
        }
      }

      // TypeScript/JS security blacklist
      if (file.path.endsWith(".ts") || file.path.endsWith(".js")) {
        const tsBanned = [
          { pattern: "child_process.exec(", reason: "Use child_process.execFile() instead" },
          { pattern: "child_process.execSync(", reason: "Use child_process.execFileSync() instead" },
          { pattern: "eval(", reason: "Dynamic code execution is forbidden" },
          { pattern: "Function(", reason: "Dynamic code execution via Function constructor is forbidden" },
        ]
        for (const { pattern, reason } of tsBanned) {
          if (content.includes(pattern)) {
            errors.push({
              check: "security",
              message: `Forbidden pattern: ${pattern}`,
              file: file.path,
              suggestion: reason,
            })
          }
        }
      }

      // Go security blacklist
      if (file.path.endsWith(".go")) {
        if (content.includes('"unsafe"')) {
          errors.push({
            check: "security",
            message: 'Forbidden import: "unsafe"',
            file: file.path,
            suggestion: "Remove usage of unsafe package",
          })
        }
      }

      // Shell security blacklist
      if (file.path.endsWith(".sh")) {
        const shellBanned = [
          { pattern: "curl | bash", reason: "Piping remote code to shell is forbidden" },
          { pattern: "curl |bash", reason: "Piping remote code to shell is forbidden" },
          { pattern: "wget -O- | sh", reason: "Piping remote code to shell is forbidden" },
          { pattern: "rm -rf /", reason: "Destructive root deletion is forbidden" },
        ]
        for (const { pattern, reason } of shellBanned) {
          if (content.includes(pattern)) {
            errors.push({
              check: "security",
              message: `Forbidden pattern: ${pattern}`,
              file: file.path,
              suggestion: reason,
            })
          }
        }
      }
    }

    return { passed: errors.length === 0, errors, warnings }
  }

  async smokeTest(code: GeneratedCode): Promise<CheckResult> {
    const dir = await materialize(code)
    let socketPath: string | null = null
    let server: net.Server | null = null
    let registered = false

    try {
      // 1. Run setup commands (timeout 60s)
      for (const cmd of code.setupCommands) {
        try {
          await run("bash", ["-lc", cmd], dir, 60_000)
        } catch (error) {
          return {
            passed: false,
            errors: [{
              check: "smoke",
              message: `Setup command failed: ${cmd} — ${error instanceof Error ? error.message : String(error)}`,
              suggestion: "Fix the setup command or dependencies",
            }],
            warnings: [],
          }
        }
      }

      // 2. Create mock Unix socket
      socketPath = path.join(dir, "test.sock")
      server = await createMockSocket(socketPath, (data) => {
        try {
          const msg = JSON.parse(data)
          if (msg.type === "tentacle_register") {
            registered = true
          }
        } catch {}
      })

      // 3. Start tentacle (timeout 5s)
      const env = {
        ...process.env,
        OPENCEPH_SOCKET_PATH: socketPath,
        OPENCEPH_IPC_SOCKET: socketPath,
        OPENCEPH_TENTACLE_ID: "smoke_test",
        OPENCEPH_TRIGGER_MODE: "external",
      }

      const child = await import("child_process").then((cp) =>
        cp.spawn("bash", ["-lc", code.entryCommand], { cwd: dir, env, stdio: "pipe" })
      )

      // 4. Wait for registration (5s max)
      const startTime = Date.now()
      while (!registered && Date.now() - startTime < 5000) {
        await new Promise((r) => setTimeout(r, 200))
      }

      // 5. Send kill directive
      if (server) {
        const killMsg = JSON.stringify({
          type: "directive",
          sender: "brain",
          receiver: "smoke_test",
          payload: { action: "kill" },
          timestamp: new Date().toISOString(),
          message_id: "smoke-kill",
        }) + "\n"
        // Send to all connected clients
        for (const conn of (server as any).__connections ?? []) {
          try { conn.write(killMsg) } catch {}
        }
      }

      // 6. Wait for exit
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGTERM")
          resolve()
        }, 2000)
        child.on("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })

      if (!registered) {
        return {
          passed: false,
          errors: [{
            check: "smoke",
            message: "Tentacle did not send tentacle_register within 5 seconds",
            suggestion: "Ensure the tentacle sends tentacle_register immediately after connecting",
          }],
          warnings: [],
        }
      }

      return { passed: true, errors: [], warnings: [] }
    } catch (error) {
      return {
        passed: false,
        errors: [{
          check: "smoke",
          message: `Smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
          suggestion: "Ensure the tentacle can start and register within 5 seconds",
        }],
        warnings: [],
      }
    } finally {
      if (server) {
        server.close()
      }
      if (socketPath) {
        try { await fs.unlink(socketPath) } catch {}
      }
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────

async function materialize(code: GeneratedCode): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openceph-validator-"))
  for (const file of code.files) {
    const fullPath = path.join(dir, file.path)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, file.content, "utf-8")
    if (file.path.endsWith(".sh")) {
      await fs.chmod(fullPath, 0o755)
    }
  }
  return dir
}

function run(command: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message))
      } else {
        resolve()
      }
    })
  })
}

function createMockSocket(socketPath: string, onData: (data: string) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const connections: net.Socket[] = []
    const server = net.createServer((conn) => {
      connections.push(conn)
      let buffer = ""
      conn.on("data", (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (line.trim()) onData(line)
        }
      })
      conn.on("close", () => {
        const idx = connections.indexOf(conn)
        if (idx >= 0) connections.splice(idx, 1)
      })
    })
    ;(server as any).__connections = connections
    server.on("error", reject)
    server.listen(socketPath, () => resolve(server))
  })
}
