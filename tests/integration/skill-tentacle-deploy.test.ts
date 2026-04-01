import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { initLoggers } from "../../src/logger/index.js"
import { SkillInspector } from "../../src/skills/skill-inspector.js"
import { SkillLoader } from "../../src/skills/skill-loader.js"
import { SkillSpawner } from "../../src/skills/skill-spawner.js"
import { CodeAgent } from "../../src/code-agent/code-agent.js"
import { IpcServer } from "../../src/tentacle/ipc-server.js"
import { TentacleRegistry } from "../../src/tentacle/registry.js"
import { PendingReportsQueue } from "../../src/tentacle/pending-reports.js"
import { TentacleManager } from "../../src/tentacle/manager.js"

describe("integration: skill_tentacle deploy (Scene 1)", () => {
  let dir: string
  let logDir: string
  let previousTestApiKey: string | undefined

  beforeAll(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-deploy-log-"))
    initLoggers({
      logging: { logDir, level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    } as any)
  })

  afterAll(() => {
    fs.rmSync(logDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    previousTestApiKey = process.env.TEST_API_KEY
    process.env.TEST_API_KEY = "test-key"
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-tentacle-deploy-"))
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true })
    fs.writeFileSync(path.join(dir, "workspace", "TENTACLES.md"), "# TENTACLES.md\n")
  })

  afterEach(() => {
    if (previousTestApiKey === undefined) {
      delete process.env.TEST_API_KEY
    } else {
      process.env.TEST_API_KEY = previousTestApiKey
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function createSkillTentacleDir(skillName: string): string {
    const skillDir = path.join(dir, "skills", skillName)
    fs.mkdirSync(path.join(skillDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(skillDir, "src"), { recursive: true })

    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: ${skillName}
description: A test skill tentacle for integration testing
version: 1.0.0
metadata:
  openceph:
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: every 30 minutes
      setup_commands:
        - pip install -r src/requirements.txt
      requires:
        env:
          - TEST_API_KEY
      capabilities:
        - api_integration
---
# ${skillName}

A skill tentacle for testing.
`)

    fs.writeFileSync(path.join(skillDir, "README.md"), `# ${skillName}

## Environment Variables
- TEST_API_KEY: API key for the test service

## Deploy / Setup
1. Install dependencies
2. Configure .env

## Start Command
python src/main.py
`)

    fs.writeFileSync(path.join(skillDir, "prompt", "SYSTEM.md"), `You are ${skillName}, a specialized tentacle for integration testing. You monitor test data and report findings to the brain. Your user is {USER_NAME} and they focus on {USER_TECHNICAL_FOCUS}.`)

    fs.writeFileSync(path.join(skillDir, "src", "main.py"), `import os
import json
import sys

def send(t, payload):
    sys.stdout.write(json.dumps({"type": t, "sender": os.environ["OPENCEPH_TENTACLE_ID"], "receiver": "brain", "payload": payload}) + "\\n")
    sys.stdout.flush()

send("tentacle_register", {"purpose": "test", "runtime": "python"})

import time
while True:
    time.sleep(60)
`)

    fs.writeFileSync(path.join(skillDir, "src", "ipc_client.py"), `"""IPC client for communicating with the OpenCeph brain."""
import os
import json
import sys

class IpcClient:
    def __init__(self):
        pass

    def send(self, msg_type, payload):
        sys.stdout.write(json.dumps({
            "type": msg_type,
            "sender": os.environ.get("OPENCEPH_TENTACLE_ID", "unknown"),
            "receiver": "brain",
            "payload": payload
        }) + "\\n")
        sys.stdout.flush()
`)

    fs.writeFileSync(path.join(skillDir, "src", "requirements.txt"), "requests>=2.28.0\n")

    return skillDir
  }

  it("SkillInspector.isSkillTentacle returns true for valid skill_tentacle directory", () => {
    const skillDir = createSkillTentacleDir("test-tentacle")
    expect(SkillInspector.isSkillTentacle(skillDir)).toBe(true)
  })

  it("SkillInspector.isSkillTentacle returns false when prompt/SYSTEM.md is missing", () => {
    const skillDir = createSkillTentacleDir("test-no-prompt")
    fs.rmSync(path.join(skillDir, "prompt", "SYSTEM.md"))
    expect(SkillInspector.isSkillTentacle(skillDir)).toBe(false)
  })

  it("SkillInspector.isSkillTentacle returns false when src/ is missing", () => {
    const skillDir = createSkillTentacleDir("test-no-src")
    fs.rmSync(path.join(skillDir, "src"), { recursive: true })
    expect(SkillInspector.isSkillTentacle(skillDir)).toBe(false)
  })

  it("SkillInspector.isSkillTentacle returns false when README.md is missing", () => {
    const skillDir = createSkillTentacleDir("test-no-readme")
    fs.rmSync(path.join(skillDir, "README.md"))
    expect(SkillInspector.isSkillTentacle(skillDir)).toBe(false)
  })

  it("TentacleValidator (validateSkillTentacle) passes for complete skill_tentacle", async () => {
    const skillDir = createSkillTentacleDir("test-valid")
    const result = await SkillInspector.validateSkillTentacle(skillDir)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("validateSkillTentacle fails when SKILL.md lacks tentacle.spawnable", async () => {
    const skillDir = createSkillTentacleDir("test-no-spawnable")
    // Overwrite SKILL.md without metadata.openceph.tentacle.spawnable
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---
name: test-no-spawnable
description: Missing spawnable flag
version: 1.0.0
spawnable: true
runtime: python
entry: src/main.py
---
# test-no-spawnable
`)
    const result = await SkillInspector.validateSkillTentacle(skillDir)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("spawnable"))).toBe(true)
  })

  it("validateSkillTentacle reports warning for short SYSTEM.md", async () => {
    const skillDir = createSkillTentacleDir("test-short-prompt")
    fs.writeFileSync(path.join(skillDir, "prompt", "SYSTEM.md"), "Short.")
    const result = await SkillInspector.validateSkillTentacle(skillDir)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("SYSTEM.md"))).toBe(true)
  })

  it("SkillLoader detects skill_tentacle and sets isSkillTentacle=true", async () => {
    createSkillTentacleDir("loader-test")
    const loader = new SkillLoader([path.join(dir, "skills")])
    const skills = await loader.loadAll()
    const skill = loader.get("loader-test")
    expect(skill).toBeDefined()
    expect(skill!.isSkillTentacle).toBe(true)
    expect(skill!.skillTentacleConfig).toBeDefined()
    expect(skill!.skillTentacleConfig!.runtime).toBe("python")
    expect(skill!.skillTentacleConfig!.entry).toBe("src/main.py")
  })

  it("spawn() routes to spawnFromSkillTentacle for skill_tentacle (CodeAgent mocked)", async () => {
    createSkillTentacleDir("deploy-test")

    const config = {
      tentacle: { ipcSocketPath: path.join(dir, "sock"), codeGenMaxRetries: 3, crashRestartMaxAttempts: 3 },
      agents: { defaults: { workspace: path.join(dir, "workspace") } },
      skills: { paths: [path.join(dir, "skills")] },
    } as any

    const ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()
    const queue = new PendingReportsQueue(path.join(dir, "pending.json"))
    const manager = new TentacleManager(config, ipc, new TentacleRegistry(path.join(dir, "workspace")), queue)
    const loader = new SkillLoader([path.join(dir, "skills")])

    const codeAgent = new CodeAgent({} as any, config)
    // Mock deployExisting to avoid actual Claude Code execution
    codeAgent.deployExisting = vi.fn().mockResolvedValue(undefined)

    // Mock spawn/register to avoid real process start
    vi.spyOn(manager, "spawn").mockResolvedValue(undefined)
    vi.spyOn(manager, "waitForRegistration").mockResolvedValue(true)
    vi.spyOn(manager, "getStatus").mockReturnValue({ pid: 99999 } as any)

    const spawner = new SkillSpawner(config, loader, manager, codeAgent)

    const result = await spawner.spawn({
      mode: "deploy",
      skillName: "deploy-test",
      tentacleId: "t_deploy_test",
      purpose: "integration test deployment",
      workflow: "Test the skill_tentacle deployment flow",
      userConfirmed: true,
    })

    expect(result.success).toBe(true)
    expect(result.tentacleId).toBe("t_deploy_test")
    expect(result.deployed).toBe(true)
    expect(result.spawned).toBe(true)
    expect(result.pid).toBe(99999)
    expect(result.source).toBe("skill_tentacle:deploy-test")
    expect(result.runtime).toBe("python")

    // Verify tentacle.json was written
    const tentacleDir = manager.getTentacleDir("t_deploy_test")
    expect(fs.existsSync(path.join(tentacleDir, "tentacle.json"))).toBe(true)
    const tentacleJson = JSON.parse(fs.readFileSync(path.join(tentacleDir, "tentacle.json"), "utf-8"))
    expect(tentacleJson.tentacleId).toBe("t_deploy_test")
    expect(tentacleJson.source).toBe("skill_tentacle:deploy-test")

    // Verify files were copied
    expect(fs.existsSync(path.join(tentacleDir, "SKILL.md"))).toBe(true)
    expect(fs.existsSync(path.join(tentacleDir, "README.md"))).toBe(true)
    expect(fs.existsSync(path.join(tentacleDir, "prompt", "SYSTEM.md"))).toBe(true)
    expect(fs.existsSync(path.join(tentacleDir, "src", "main.py"))).toBe(true)
    expect(fs.existsSync(path.join(tentacleDir, "src", "ipc_client.py"))).toBe(true)

    // Scene A (deploy): NEVER calls Code Agent — pure copy + setup + spawn
    expect(codeAgent.deployExisting).not.toHaveBeenCalled()

    await ipc.stop()
  }, 20_000)

  it("spawn() returns errors when validation fails for skill_tentacle", async () => {
    const skillDir = createSkillTentacleDir("deploy-invalid")
    // Remove src/ to cause validation failure
    fs.rmSync(path.join(skillDir, "src"), { recursive: true })

    const config = {
      tentacle: { ipcSocketPath: path.join(dir, "sock"), codeGenMaxRetries: 3, crashRestartMaxAttempts: 3 },
      agents: { defaults: { workspace: path.join(dir, "workspace") } },
      skills: { paths: [path.join(dir, "skills")] },
    } as any

    const ipc = new IpcServer(path.join(dir, "sock"))
    await ipc.start()
    const queue = new PendingReportsQueue(path.join(dir, "pending.json"))
    const manager = new TentacleManager(config, ipc, new TentacleRegistry(path.join(dir, "workspace")), queue)
    const loader = new SkillLoader([path.join(dir, "skills")])
    const codeAgent = new CodeAgent({} as any, config)
    codeAgent.deployExisting = vi.fn().mockResolvedValue(undefined)

    const spawner = new SkillSpawner(config, loader, manager, codeAgent)

    const result = await spawner.spawn({
      mode: "deploy",
      skillName: "deploy-invalid",
      tentacleId: "t_deploy_invalid",
      purpose: "should fail validation",
      workflow: "Test validation failure path",
      userConfirmed: true,
    })

    expect(result.success).toBe(false)
    expect(result.errors).toBeDefined()
    expect(result.errors!.length).toBeGreaterThan(0)

    await ipc.stop()
  }, 20_000)
})
