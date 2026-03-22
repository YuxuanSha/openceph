import { execFile } from "child_process"
import { existsSync } from "fs"
import * as fs from "fs/promises"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import type { GeneratedCode, ValidationError } from "./code-agent.js"
import { SkillInspector } from "../skills/skill-inspector.js"
import { systemLogger } from "../logger/index.js"

export interface CheckResult {
  passed: boolean
  errors: ValidationError[]
  warnings: string[]
}

export interface ValidationResult {
  passed: boolean
  checks: {
    structure?: CheckResult
    syntax: CheckResult
    contract: CheckResult
    security: CheckResult
    smoke: CheckResult
  }
}

export class TentacleValidator {
  private smokeTestTimeoutMs = 5000

  setSmokeTestTimeoutMs(ms: number): void {
    this.smokeTestTimeoutMs = ms
  }

  /**
   * M4: Validate a skill_tentacle directory on disk.
   * Runs structure + syntax + contract + security + smoke checks.
   */
  async validateSkillTentacle(target: string): Promise<ValidationResult> {
    // Read files from disk into GeneratedCode format
    const files = await readFilesFromDir(target)
    const runtime = inferRuntimeFromFiles(files)

    // Detect entry command and setup commands from SKILL.md frontmatter
    const entryCommand = inferEntryCommandFromFiles(files, runtime, target)
    const setupCommands = inferSetupCommandsFromFiles(files)

    const code: GeneratedCode = {
      runtime,
      files,
      entryCommand,
      setupCommands,
      description: "skill_tentacle validation",
    }

    // Structure check uses semantic frontmatter parsing via SkillInspector
    const structure = await this.structureCheck(target)

    const [syntax, contract, security] = await Promise.all([
      this.syntaxCheck(code),
      this.contractCheck(code),
      this.securityCheck(code),
    ])

    // Smoke test only runs if prior checks pass (and entry command is known)
    let smoke: CheckResult
    if (structure.passed && syntax.passed && contract.passed && security.passed && entryCommand) {
      smoke = await this.smokeTestOnDisk(target, entryCommand, setupCommands, this.smokeTestTimeoutMs)
    } else {
      smoke = { passed: true, errors: [], warnings: ["Smoke test skipped (prior checks failed or no entry command)"] }
    }

    const passed = structure.passed && syntax.passed && contract.passed && security.passed && smoke.passed

    systemLogger.info("skill_tentacle_validation", {
      target,
      passed,
      checks: {
        structure: structure.passed,
        syntax: syntax.passed,
        contract: contract.passed,
        security: security.passed,
        smoke: smoke.passed,
      },
    })

    return {
      passed,
      checks: { structure, syntax, contract, security, smoke },
    }
  }

  /**
   * M4: Structure completeness check for skill_tentacle directories.
   */
  async structureCheck(dir: string): Promise<CheckResult> {
    const errors: ValidationError[] = []
    const warnings: string[] = []

    // Required files
    const required = ["SKILL.md", "README.md", "prompt/SYSTEM.md"]
    for (const f of required) {
      const fullPath = path.join(dir, f)
      try {
        await fs.access(fullPath)
      } catch {
        errors.push({ check: "structure" as any, message: `必须文件缺失：${f}` })
      }
    }

    // src/ directory must exist
    try {
      const srcStat = await fs.stat(path.join(dir, "src"))
      if (!srcStat.isDirectory()) {
        errors.push({ check: "structure" as any, message: "src/ 不是目录" })
      }
    } catch {
      errors.push({ check: "structure" as any, message: "src/ 目录缺失" })
    }

    // SKILL.md frontmatter semantic check via SkillInspector (deep YAML parsing)
    try {
      if (!SkillInspector.isSkillTentacle(dir)) {
        errors.push({
          check: "structure" as any,
          message: "SKILL.md frontmatter 缺少 metadata.openceph.tentacle.spawnable: true（或缺少 prompt/SYSTEM.md / src/ / README.md）",
        })
      }
    } catch {
      // SKILL.md missing already reported above
    }

    // README.md content check
    try {
      const readme = await fs.readFile(path.join(dir, "README.md"), "utf-8")
      if (!readme.includes("环境变量") && !readme.includes("Environment") && !readme.includes("env")) {
        warnings.push("README.md 缺少环境变量章节")
      }
      if (!readme.includes("部署") && !readme.includes("Deploy") && !readme.includes("Setup") && !readme.includes("Install")) {
        warnings.push("README.md 缺少部署步骤章节")
      }
    } catch {
      // README.md missing already reported above
    }

    // prompt/SYSTEM.md non-empty check
    try {
      const systemMd = await fs.readFile(path.join(dir, "prompt", "SYSTEM.md"), "utf-8")
      if (systemMd.trim().length < 50) {
        errors.push({ check: "structure" as any, message: "prompt/SYSTEM.md 内容过短（< 50 字符）" })
      }
    } catch {
      // Already reported above
    }

    return { passed: errors.length === 0, errors, warnings }
  }

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

  /**
   * Smoke test that runs directly from an on-disk directory (no materialize).
   * Used by validateSkillTentacle for deployed/generated directories.
   */
  private async smokeTestOnDisk(
    dir: string,
    entryCommand: string,
    setupCommands: string[],
    timeoutMs: number,
  ): Promise<CheckResult> {
    let socketPath: string | null = null
    let server: net.Server | null = null
    let registered = false

    try {
      // Run setup commands if any (e.g., pip install) — skip if venv already exists
      for (const cmd of setupCommands) {
        // Skip setup if it creates a venv that already exists
        if (cmd.includes("venv") && existsSync(path.join(dir, "venv"))) continue
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

      // Create mock socket in a temp location
      socketPath = path.join(os.tmpdir(), `openceph-smoke-${Date.now()}.sock`)
      server = await createMockSocket(socketPath, (data) => {
        try {
          const msg = JSON.parse(data)
          if (msg.type === "tentacle_register") registered = true
        } catch {}
      })

      const env = {
        ...process.env,
        OPENCEPH_SOCKET_PATH: socketPath,
        OPENCEPH_IPC_SOCKET: socketPath,
        OPENCEPH_TENTACLE_ID: "smoke_test",
        OPENCEPH_TRIGGER_MODE: "external",
      }

      const child = await import("child_process").then((cp) =>
        cp.spawn("bash", ["-lc", entryCommand], { cwd: dir, env, stdio: "pipe" })
      )

      // Wait for registration within timeout
      const startTime = Date.now()
      while (!registered && Date.now() - startTime < timeoutMs) {
        await new Promise((r) => setTimeout(r, 200))
      }

      // Send kill directive
      if (server) {
        const killMsg = JSON.stringify({
          type: "directive",
          sender: "brain",
          receiver: "smoke_test",
          payload: { action: "kill" },
          timestamp: new Date().toISOString(),
          message_id: "smoke-kill",
        }) + "\n"
        for (const conn of (server as any).__connections ?? []) {
          try { conn.write(killMsg) } catch {}
        }
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGTERM"); resolve() }, 2000)
        child.on("exit", () => { clearTimeout(timer); resolve() })
      })

      if (!registered) {
        return {
          passed: false,
          errors: [{
            check: "smoke",
            message: `Tentacle did not send tentacle_register within ${timeoutMs}ms`,
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
          suggestion: "Ensure the tentacle can start and register",
        }],
        warnings: [],
      }
    } finally {
      if (server) server.close()
      if (socketPath) {
        try { await fs.unlink(socketPath) } catch {}
      }
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

async function readFilesFromDir(dir: string): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = []
  const walk = async (d: string, prefix: string) => {
    let entries
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (["venv", "node_modules", "__pycache__", ".git", "data"].includes(entry.name)) continue
        await walk(path.join(d, entry.name), relPath)
      } else if (/\.(py|ts|js|go|sh|md|txt|json|yaml|yml|toml|env)$/.test(entry.name)) {
        try {
          const content = await fs.readFile(path.join(d, entry.name), "utf-8")
          files.push({ path: relPath, content })
        } catch {
          // skip unreadable files
        }
      }
    }
  }
  await walk(dir, "")
  return files
}

function inferRuntimeFromFiles(files: Array<{ path: string }>): string {
  if (files.some((f) => f.path.endsWith(".py"))) return "python"
  if (files.some((f) => f.path.endsWith(".ts"))) return "typescript"
  if (files.some((f) => f.path.endsWith(".go"))) return "go"
  if (files.some((f) => f.path.endsWith(".sh"))) return "shell"
  return "python"
}

function inferEntryCommandFromFiles(
  files: Array<{ path: string; content: string }>,
  runtime: string,
  dir: string,
): string {
  // Try to get entry from SKILL.md frontmatter
  const skillMd = files.find((f) => f.path === "SKILL.md")
  if (skillMd) {
    const entryMatch = skillMd.content.match(/^\s+entry:\s*(.+)/m)
    const entry = entryMatch?.[1]?.trim()
    if (entry) {
      const hasVenv = existsSync(path.join(dir, "venv", "bin", "python"))
      if (runtime === "python") return hasVenv ? `venv/bin/python ${entry}` : `python3 ${entry}`
      if (runtime === "typescript") return `npx tsx ${entry}`
      if (runtime === "go") return `go run ${entry}`
      if (runtime === "shell") return `bash ${entry}`
      return entry
    }
  }
  // Fallback by runtime
  const hasVenv = existsSync(path.join(dir, "venv", "bin", "python"))
  if (runtime === "python") {
    const mainPy = files.find((f) => f.path === "src/main.py")
    return mainPy ? (hasVenv ? "venv/bin/python src/main.py" : "python3 src/main.py") : ""
  }
  if (runtime === "typescript") return "npx tsx src/index.ts"
  return ""
}

function inferSetupCommandsFromFiles(files: Array<{ path: string; content: string }>): string[] {
  const skillMd = files.find((f) => f.path === "SKILL.md")
  if (!skillMd) return []
  // Parse setup_commands list from SKILL.md frontmatter
  const setupMatch = skillMd.content.match(/setup_commands:\s*\n((?:\s+-\s+.+\n?)+)/)
  if (!setupMatch) return []
  return setupMatch[1]
    .split("\n")
    .map((line) => line.trim().replace(/^-\s*/, "").trim())
    .filter(Boolean)
}
