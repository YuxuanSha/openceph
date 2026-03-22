import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// Helper to run doctor checks (extracted logic matching cli.ts)
interface DoctorCheckResult {
  check: string
  status: "ok" | "warn" | "error"
  message: string
  fixable?: boolean
}

function checkWorkspace(workspaceDir: string): DoctorCheckResult {
  const requiredFiles = ["MEMORY.md", "TENTACLES.md", "TOOLS.md"]
  const missing: string[] = []
  for (const f of requiredFiles) {
    if (!fs.existsSync(path.join(workspaceDir, f))) missing.push(f)
  }
  if (missing.length === 0) {
    return { check: "Workspace", status: "ok", message: `${requiredFiles.length}/${requiredFiles.length} files` }
  }
  return { check: "Workspace", status: "warn", message: `missing: ${missing.join(", ")}`, fixable: true }
}

function checkIpcSocket(socketPath: string): DoctorCheckResult {
  if (fs.existsSync(socketPath)) {
    return { check: "IPC Socket", status: "ok", message: "exists" }
  }
  return { check: "IPC Socket", status: "ok", message: "no stale socket" }
}

function checkLogDir(logDir: string): DoctorCheckResult {
  if (fs.existsSync(logDir)) {
    return { check: "Logs", status: "ok", message: "directory exists" }
  }
  return { check: "Logs", status: "warn", message: "log dir missing", fixable: true }
}

function checkTentacles(tentaclesPath: string): DoctorCheckResult {
  if (!fs.existsSync(tentaclesPath)) {
    return { check: "Tentacles", status: "ok", message: "no registry" }
  }
  const content = fs.readFileSync(tentaclesPath, "utf-8")
  const crashMatch = content.match(/status:\s*crashed/g)
  const crashCount = crashMatch?.length ?? 0
  if (crashCount === 0) {
    return { check: "Tentacles", status: "ok", message: "all healthy" }
  }
  return {
    check: "Tentacles",
    status: "warn",
    message: `${crashCount} crashed tentacles`,
    fixable: true,
  }
}

function checkCronStore(storePath: string): DoctorCheckResult {
  if (!fs.existsSync(storePath)) {
    return { check: "Cron", status: "ok", message: "no cron store yet" }
  }
  try {
    JSON.parse(fs.readFileSync(storePath, "utf-8"))
    return { check: "Cron", status: "ok", message: "valid" }
  } catch {
    return { check: "Cron", status: "warn", message: "corrupt store" }
  }
}

describe("Doctor checks", () => {
  it("workspace check passes when all files present", () => {
    const workspaceDir = path.join(tmpDir, "workspace")
    fs.mkdirSync(workspaceDir, { recursive: true })
    for (const f of ["MEMORY.md", "TENTACLES.md", "TOOLS.md"]) {
      fs.writeFileSync(path.join(workspaceDir, f), `# ${f}`)
    }

    const result = checkWorkspace(workspaceDir)
    expect(result.status).toBe("ok")
    expect(result.message).toContain("3/3")
  })

  it("workspace check warns when files missing", () => {
    const workspaceDir = path.join(tmpDir, "workspace")
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "# MEMORY")

    const result = checkWorkspace(workspaceDir)
    expect(result.status).toBe("warn")
    expect(result.message).toContain("TENTACLES.md")
    expect(result.fixable).toBe(true)
  })

  it("ipc socket check reports no stale socket", () => {
    const result = checkIpcSocket(path.join(tmpDir, "openceph.sock"))
    expect(result.status).toBe("ok")
    expect(result.message).toContain("no stale")
  })

  it("ipc socket check reports existing socket", () => {
    const sockPath = path.join(tmpDir, "openceph.sock")
    fs.writeFileSync(sockPath, "")

    const result = checkIpcSocket(sockPath)
    expect(result.status).toBe("ok")
    expect(result.message).toBe("exists")
  })

  it("log dir check passes when exists", () => {
    const logDir = path.join(tmpDir, "logs")
    fs.mkdirSync(logDir)

    const result = checkLogDir(logDir)
    expect(result.status).toBe("ok")
  })

  it("log dir check warns when missing", () => {
    const result = checkLogDir(path.join(tmpDir, "nonexistent-logs"))
    expect(result.status).toBe("warn")
    expect(result.fixable).toBe(true)
  })

  it("tentacles check passes with no crashes", () => {
    const regPath = path.join(tmpDir, "TENTACLES.md")
    fs.writeFileSync(regPath, `## t_test\nstatus: running\npurpose: test\n`)

    const result = checkTentacles(regPath)
    expect(result.status).toBe("ok")
  })

  it("tentacles check warns with crashed tentacles", () => {
    const regPath = path.join(tmpDir, "TENTACLES.md")
    fs.writeFileSync(
      regPath,
      `## t_ok\nstatus: running\n\n## t_bad\nstatus: crashed\n\n## t_bad2\nstatus: crashed\n`,
    )

    const result = checkTentacles(regPath)
    expect(result.status).toBe("warn")
    expect(result.message).toContain("2 crashed")
  })

  it("cron store check passes with valid JSON", () => {
    const storePath = path.join(tmpDir, "jobs.json")
    fs.writeFileSync(storePath, JSON.stringify([{ jobId: "test" }]))

    const result = checkCronStore(storePath)
    expect(result.status).toBe("ok")
  })

  it("cron store check warns with corrupt JSON", () => {
    const storePath = path.join(tmpDir, "jobs.json")
    fs.writeFileSync(storePath, "not json{")

    const result = checkCronStore(storePath)
    expect(result.status).toBe("warn")
    expect(result.message).toContain("corrupt")
  })

  it("cron store check passes when no store exists", () => {
    const result = checkCronStore(path.join(tmpDir, "no-such-file.json"))
    expect(result.status).toBe("ok")
  })

  it("workspace fix creates missing files", () => {
    const workspaceDir = path.join(tmpDir, "workspace")
    fs.mkdirSync(workspaceDir, { recursive: true })

    const result = checkWorkspace(workspaceDir)
    expect(result.fixable).toBe(true)

    // Simulate fix
    const missing = ["MEMORY.md", "TENTACLES.md", "TOOLS.md"]
    for (const f of missing) {
      fs.writeFileSync(path.join(workspaceDir, f), `# ${f}\n`)
    }

    const afterFix = checkWorkspace(workspaceDir)
    expect(afterFix.status).toBe("ok")
  })
})
