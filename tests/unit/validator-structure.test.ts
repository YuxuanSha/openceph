import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { TentacleValidator } from "../../src/code-agent/validator.js"
import { initLoggers } from "../../src/logger/index.js"

describe("TentacleValidator structure checks", () => {
  let dir: string
  let validator: TentacleValidator

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-validator-struct-"))
    validator = new TentacleValidator()
    initLoggers({
      logging: { logDir: path.join(dir, "logs"), level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    } as any)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function createValidSkillTentacle(base: string) {
    fs.mkdirSync(path.join(base, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(base, "src"), { recursive: true })
    fs.writeFileSync(path.join(base, "SKILL.md"), `---\nname: test\ndescription: test\nversion: 1.0.0\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n---\n`)
    fs.writeFileSync(path.join(base, "README.md"), "# Test\n\n## Environment Variables\n\n## Deploy Steps\n\nbash commands here\n")
    fs.writeFileSync(path.join(base, "prompt", "SYSTEM.md"), "# Identity\nYou are a test tentacle.\n\n# Mission\nTest the validation system thoroughly and report findings.")
    fs.writeFileSync(path.join(base, "src", "main.py"), `
import os, sys, json, uuid, time
TENTACLE_ID = os.environ.get("OPENCEPH_TENTACLE_ID", "test")
TRIGGER_MODE = os.environ.get("OPENCEPH_TRIGGER_MODE", "self")
sys.stdout.write(json.dumps({"type": "tentacle_register", "sender": TENTACLE_ID, "receiver": "brain", "payload": {"tentacle_id": TENTACLE_ID, "purpose": "test", "runtime": "python", "pid": os.getpid()}, "timestamp": "", "message_id": str(uuid.uuid4())}) + "\\n")
sys.stdout.flush()
running = True
paused = False
def handle_directive(data):
    global running, paused
    action = data.get("payload", {}).get("action", "")
    if action == "kill": running = False
    if action == "pause": paused = True
    if action == "resume": paused = False
    if action == "run_now": paused = False
def consultation_request(items, summary):
    sys.stdout.write(json.dumps({"type": "consultation_request", "sender": TENTACLE_ID, "receiver": "brain", "payload": {"tentacle_id": TENTACLE_ID, "request_id": str(uuid.uuid4()), "mode": "batch", "items": items, "summary": summary}, "timestamp": "", "message_id": str(uuid.uuid4())}) + "\\n")
    sys.stdout.flush()
def reader():
    global running, paused
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        message = json.loads(line)
        if message.get("type") == "directive":
            handle_directive(message)
if TRIGGER_MODE == "self":
    while running:
        if not paused:
            consultation_request([], "no findings")
        time.sleep(60)
`)
  }

  it("returns structure as a named check", async () => {
    createValidSkillTentacle(dir)
    const result = await validator.validateSkillTentacle(dir)
    expect(result.checks.structure).toBeDefined()
    expect(result.checks.syntax).toBeDefined()
    expect(result.checks.contract).toBeDefined()
    expect(result.checks.security).toBeDefined()
    expect(result.checks.smoke).toBeDefined()
  })

  it("passes structure check for valid skill_tentacle directory", async () => {
    createValidSkillTentacle(dir)
    const result = await validator.validateSkillTentacle(dir)
    expect(result.checks.structure?.passed).toBe(true)
    expect(result.checks.structure?.errors).toHaveLength(0)
  })

  it("fails when SKILL.md is missing", async () => {
    createValidSkillTentacle(dir)
    fs.unlinkSync(path.join(dir, "SKILL.md"))
    const result = await validator.validateSkillTentacle(dir)
    expect(result.passed).toBe(false)
    const allErrors = Object.values(result.checks).flatMap(c => c?.errors ?? [])
    expect(allErrors.some(e => e.message.includes("SKILL.md"))).toBe(true)
  })

  it("fails when src/ directory is missing", async () => {
    createValidSkillTentacle(dir)
    fs.rmSync(path.join(dir, "src"), { recursive: true })
    const result = await validator.validateSkillTentacle(dir)
    expect(result.passed).toBe(false)
  })

  it("fails when prompt/SYSTEM.md is too short", async () => {
    createValidSkillTentacle(dir)
    fs.writeFileSync(path.join(dir, "prompt", "SYSTEM.md"), "Hi")
    const result = await validator.validateSkillTentacle(dir)
    expect(result.passed).toBe(false)
    const allErrors = Object.values(result.checks).flatMap(c => c?.errors ?? [])
    expect(allErrors.some(e => e.message.includes("过短") || e.message.includes("short"))).toBe(true)
  })

  it("fails when README.md is missing", async () => {
    createValidSkillTentacle(dir)
    fs.unlinkSync(path.join(dir, "README.md"))
    const result = await validator.validateSkillTentacle(dir)
    expect(result.passed).toBe(false)
  })

  it("structureCheck passes for valid dir", async () => {
    createValidSkillTentacle(dir)
    const result = await validator.structureCheck(dir)
    expect(result.passed).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("structureCheck returns warnings for missing README sections", async () => {
    createValidSkillTentacle(dir)
    fs.writeFileSync(path.join(dir, "README.md"), "# Test\n\nJust a test.")
    const result = await validator.structureCheck(dir)
    // Missing sections produce warnings, not errors
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
