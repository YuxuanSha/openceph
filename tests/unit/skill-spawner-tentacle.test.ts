import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { SkillSpawner, type SpawnParams } from "../../src/skills/skill-spawner.js"
import { SkillLoader } from "../../src/skills/skill-loader.js"
import type { TentacleManager } from "../../src/tentacle/manager.js"
import type { CodeAgent } from "../../src/code-agent/code-agent.js"
import type { CredentialStore } from "../../src/config/credential-store.js"
import { initLoggers } from "../../src/logger/index.js"
import { TentacleValidator } from "../../src/code-agent/validator.js"

function mockSkillLoader(skills: any[] = []): SkillLoader {
  const real = new SkillLoader([])
  return {
    loadAll: vi.fn().mockResolvedValue(skills),
    get: vi.fn().mockImplementation((name: string) => skills.find(s => s.name === name) ?? null),
    loadSingle: vi.fn().mockImplementation((dir: string) => real.loadSingle(dir)),
  } as any
}

function mockTentacleManager(): TentacleManager {
  return {
    getTentacleBaseDir: () => "/tmp/test-tentacles",
    getTentacleDir: (id: string) => `/tmp/test-tentacles/${id}`,
    spawn: vi.fn().mockResolvedValue(undefined),
    waitForRegistration: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn().mockReturnValue(null),
    kill: vi.fn().mockResolvedValue(true),
    listAll: vi.fn().mockReturnValue([]),
  } as any
}

function mockCodeAgent(): CodeAgent {
  return {
    deployExisting: vi.fn().mockResolvedValue({ success: true, output: "deployed" }),
    generateSkillTentacle: vi.fn().mockResolvedValue({ success: true, output: "generated" }),
    fixSkillTentacle: vi.fn().mockResolvedValue({ success: true, output: "fixed" }),
  } as any
}

function mockCredentialStore(values: Record<string, string> = {}): CredentialStore {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (!(key in values)) {
        throw new Error(`not found: ${key}`)
      }
      return values[key]
    }),
  } as any
}

describe("SkillSpawner tentacle routing", () => {
  let dir: string
  let logDir: string

  beforeAll(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-spawner-log-"))
    initLoggers({
      logging: { logDir, level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    } as any)
  })

  afterAll(() => {
    fs.rmSync(logDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-spawner-test-"))
    fs.mkdirSync(path.join(dir, "tentacles"), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function makeConfig() {
    return {
      tentacle: {
        maxActive: 20,
        ipcSocketPath: path.join("/tmp", "test.sock"),
        codeGenMaxRetries: 3,
        codeGenTimeoutMs: 5000,
        codeGenPollIntervalMs: 1000,
        codeGenIdleTimeoutMs: 3000,
        crashRestartMaxAttempts: 3,
        confidenceThresholds: { directReport: 0.8, consultation: 0.4, discard: 0 },
      },
      skills: { paths: [path.join(dir, "skills")] },
      agents: { defaults: { workspace: path.join(dir, "workspace") } },
    } as any
  }

  it("routes to spawnFromScratch when no skill name provided", async () => {
    const codeAgent = mockCodeAgent()
    const manager = mockTentacleManager()
    const spawner = new SkillSpawner(makeConfig(), mockSkillLoader(), manager, codeAgent)

    const params: SpawnParams = {
      mode: "create",
      tentacleId: "t_test",
      purpose: "test",
      workflow: "test workflow",
      userConfirmed: true,
    }

    // This will try to generate from scratch
    // Since we're mocking, it may fail at validation but the routing is correct
    try {
      await spawner.spawn(params)
    } catch {
      // Expected — the mock doesn't produce real files
    }

    // Verify generateSkillTentacle was called (from-scratch path)
    expect(codeAgent.generateSkillTentacle).toHaveBeenCalled()
  })

  it("routes to legacy path for spawnable SKILL without tentacle metadata", async () => {
    const legacySkill = {
      name: "legacy-monitor",
      path: path.join(dir, "skills", "legacy-monitor"),
      description: "Legacy monitor",
      spawnable: true,
      isSkillTentacle: false,
      runtime: "python",
      entry: "scripts/main.py",
      defaultTrigger: "every 6 hours",
    }

    const codeAgent = mockCodeAgent()
    const manager = mockTentacleManager()
    const spawner = new SkillSpawner(makeConfig(), mockSkillLoader([legacySkill]), manager, codeAgent)

    const params: SpawnParams = {
      mode: "create",
      skillName: "legacy-monitor",
      tentacleId: "t_legacy",
      purpose: "test legacy",
      workflow: "test",
      userConfirmed: true,
    }

    try {
      await spawner.spawn(params)
    } catch {
      // Expected — mock doesn't produce real files
    }

    // Legacy path should NOT call generateSkillTentacle
    // It should go through the code agent's generate path (legacy)
    // The key distinction: it should NOT call deployExisting directly
    expect(codeAgent.deployExisting).not.toHaveBeenCalled()
  })

  it("routes to skill_tentacle path when isSkillTentacle is true", async () => {
    const skillTentacleDir = path.join(dir, "skills", "github-radar")
    fs.mkdirSync(path.join(skillTentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(skillTentacleDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(skillTentacleDir, "SKILL.md"), "---\nname: github-radar\nspawnable: true\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n---\n")
    fs.writeFileSync(path.join(skillTentacleDir, "README.md"), "# Deploy\n## Env\n## Steps\n")
    fs.writeFileSync(path.join(skillTentacleDir, "prompt", "SYSTEM.md"), "# Identity\nYou are github-radar.\n\n# Mission\nMonitor repos.")
    fs.writeFileSync(path.join(skillTentacleDir, "src", "main.py"), "# main\n")

    const skillEntry = {
      name: "github-radar",
      path: skillTentacleDir,
      description: "GitHub radar",
      spawnable: true,
      isSkillTentacle: true,
      skillTentacleConfig: {
        spawnable: true as const,
        runtime: "python" as const,
        entry: "src/main.py",
        defaultTrigger: "self",
        setupCommands: [],
        requires: { bins: [], env: [] },
        capabilities: [],
      },
    }

    const codeAgent = mockCodeAgent()
    const manager = mockTentacleManager()
    ;(manager as any).getTentacleBaseDir = () => path.join(dir, "tentacles")
    const spawner = new SkillSpawner(makeConfig(), mockSkillLoader([skillEntry]), manager, codeAgent)

    const params: SpawnParams = {
      mode: "deploy",
      skillName: "github-radar",
      tentacleId: "t_github_radar",
      purpose: "Monitor GitHub",
      workflow: "scan repos",
      userConfirmed: true,
    }

    try {
      await spawner.spawn(params)
    } catch {
      // May fail at deploy step but routing should be correct
    }

    // Scene A (deploy): NEVER calls Code Agent
    expect(codeAgent.deployExisting).not.toHaveBeenCalled()
    expect(codeAgent.generateSkillTentacle).not.toHaveBeenCalled()
    // Must call spawn and waitForRegistration
    expect(manager.spawn).toHaveBeenCalledWith("t_github_radar")
    expect(manager.waitForRegistration).toHaveBeenCalledWith("t_github_radar", 30_000)
  })

  it("returns spawned: true when IPC registration succeeds", async () => {
    const skillTentacleDir = path.join(dir, "skills", "test-tentacle")
    fs.mkdirSync(path.join(skillTentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(skillTentacleDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(skillTentacleDir, "SKILL.md"), "---\nname: test-tentacle\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n---\n")
    fs.writeFileSync(path.join(skillTentacleDir, "README.md"), "# Deploy\n## Env\n## Steps\n")
    fs.writeFileSync(path.join(skillTentacleDir, "prompt", "SYSTEM.md"), "# Identity\nYou are test-tentacle.\n\n# Mission\nTest.")
    fs.writeFileSync(path.join(skillTentacleDir, "src", "main.py"), "# main\n")

    const skillEntry = {
      name: "test-tentacle",
      path: skillTentacleDir,
      description: "Test",
      spawnable: true,
      isSkillTentacle: true,
      skillTentacleConfig: {
        spawnable: true as const,
        runtime: "python" as const,
        entry: "src/main.py",
        defaultTrigger: "self",
        setupCommands: [],
        requires: { bins: [], env: [] },
        capabilities: [],
      },
    }

    const codeAgent = mockCodeAgent()
    const manager = mockTentacleManager()
    ;(manager as any).getTentacleBaseDir = () => path.join(dir, "tentacles")
    ;(manager as any).getStatus = vi.fn().mockReturnValue({ pid: 12345 })
    const spawner = new SkillSpawner(makeConfig(), mockSkillLoader([skillEntry]), manager, codeAgent)

    const result = await spawner.spawn({
      mode: "deploy",
      skillName: "test-tentacle",
      tentacleId: "t_test_tentacle",
      purpose: "test",
      workflow: "test",
      userConfirmed: true,
    })

    expect(result.success).toBe(true)
    expect(result.spawned).toBe(true)
    expect(result.pid).toBe(12345)
    expect(manager.spawn).toHaveBeenCalledWith("t_test_tentacle")
    expect(manager.waitForRegistration).toHaveBeenCalled()
  })

  it("returns error when IPC registration times out", async () => {
    const skillTentacleDir = path.join(dir, "skills", "timeout-tentacle")
    fs.mkdirSync(path.join(skillTentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(skillTentacleDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(skillTentacleDir, "SKILL.md"), "---\nname: timeout-tentacle\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n---\n")
    fs.writeFileSync(path.join(skillTentacleDir, "README.md"), "# Deploy\n## Env\n## Steps\n")
    fs.writeFileSync(path.join(skillTentacleDir, "prompt", "SYSTEM.md"), "# Identity\nYou are a timeout-tentacle for testing IPC timeout behavior.\n\n# Mission\nTest the IPC registration timeout handling correctly.")
    fs.writeFileSync(path.join(skillTentacleDir, "src", "main.py"), "# main\n")

    const skillEntry = {
      name: "timeout-tentacle",
      path: skillTentacleDir,
      description: "Test timeout",
      spawnable: true,
      isSkillTentacle: true,
      skillTentacleConfig: {
        spawnable: true as const,
        runtime: "python" as const,
        entry: "src/main.py",
        defaultTrigger: "self",
        setupCommands: [],
        requires: { bins: [], env: [] },
        capabilities: [],
      },
    }

    const codeAgent = mockCodeAgent()
    const manager = mockTentacleManager()
    ;(manager as any).getTentacleBaseDir = () => path.join(dir, "tentacles")
    // Simulate registration timeout
    ;(manager as any).waitForRegistration = vi.fn().mockResolvedValue(false)

    const spawner = new SkillSpawner(makeConfig(), mockSkillLoader([skillEntry]), manager, codeAgent)

    const result = await spawner.spawn({
      mode: "deploy",
      skillName: "timeout-tentacle",
      tentacleId: "t_timeout",
      purpose: "test",
      workflow: "test",
      userConfirmed: true,
    })

    expect(result.success).toBe(false)
    expect(result.errors?.[0]).toMatch(/IPC registration timed out/)
    // kill should be called on timeout
    expect((manager as any).kill).toHaveBeenCalledWith("t_timeout", "registration_timeout")
  })

  it("routes to spawnFromPath when skillTentaclePath is a directory", async () => {
    const localTentacleDir = path.join(dir, "local-tentacle")
    fs.mkdirSync(path.join(localTentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(localTentacleDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(localTentacleDir, "SKILL.md"), "---\nname: local-tentacle\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n---\n")
    fs.writeFileSync(path.join(localTentacleDir, "README.md"), "# Deploy\n## Env\n## Steps\n")
    fs.writeFileSync(path.join(localTentacleDir, "prompt", "SYSTEM.md"), "# Identity\nYou are a local-tentacle for testing path-based routing.\n\n# Mission\nVerify that spawn correctly routes via skillTentaclePath.")
    fs.writeFileSync(path.join(localTentacleDir, "src", "main.py"), "# main\n")

    const codeAgent = mockCodeAgent()
    const manager = mockTentacleManager()
    ;(manager as any).getTentacleBaseDir = () => path.join(dir, "tentacles")
    const spawner = new SkillSpawner(makeConfig(), mockSkillLoader([]), manager, codeAgent)

    // Pass skillTentaclePath directly — should not need skillName
    try {
      await spawner.spawn({
        mode: "deploy",
        tentacleId: "t_local",
        purpose: "test local path",
        workflow: "test",
        userConfirmed: true,
        skillTentaclePath: localTentacleDir,
      })
    } catch {
      // May fail at deploy but routing is correct
    }

    // Scene A (deploy): NEVER calls Code Agent
    expect(codeAgent.deployExisting).not.toHaveBeenCalled()
    expect(codeAgent.generateSkillTentacle).not.toHaveBeenCalled()
  })

  it("fails before deploy when required environment variables are missing", async () => {
    const skillTentacleDir = path.join(dir, "skills", "needs-env")
    fs.mkdirSync(path.join(skillTentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(skillTentacleDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(skillTentacleDir, "SKILL.md"), "---\nname: needs-env\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n      requires:\n        env:\n          - OPENROUTER_API_KEY\n---\n")
    fs.writeFileSync(path.join(skillTentacleDir, "README.md"), "# Deploy\n## Environment\n## Start Command\n```bash\npython3 src/main.py\n```\n")
    fs.writeFileSync(path.join(skillTentacleDir, "prompt", "SYSTEM.md"), "# Identity\nYou are needs-env.\n\n# Mission\nRequire an API key before deployment.")
    fs.writeFileSync(path.join(skillTentacleDir, "src", "main.py"), "# main\n")

    const skillEntry = {
      name: "needs-env",
      path: skillTentacleDir,
      description: "Needs env",
      spawnable: true,
      isSkillTentacle: true,
      skillTentacleConfig: {
        spawnable: true as const,
        runtime: "python" as const,
        entry: "src/main.py",
        defaultTrigger: "self",
        setupCommands: [],
        requires: { bins: [], env: ["OPENROUTER_API_KEY"] },
        capabilities: [],
      },
    }

    const codeAgent = mockCodeAgent()
    const manager = mockTentacleManager()
    ;(manager as any).getTentacleBaseDir = () => path.join(dir, "tentacles")
    const spawner = new SkillSpawner(
      makeConfig(),
      mockSkillLoader([skillEntry]),
      manager,
      codeAgent,
      mockCredentialStore(),
    )

    const result = await spawner.spawn({
      mode: "deploy",
      skillName: "needs-env",
      tentacleId: "t_needs_env",
      purpose: "test",
      workflow: "test",
      userConfirmed: true,
    })

    expect(result.success).toBe(false)
    expect(result.errors?.[0]).toMatch(/OPENROUTER_API_KEY/)
    expect(codeAgent.deployExisting).not.toHaveBeenCalled()
    expect(manager.spawn).not.toHaveBeenCalled()
  })

  it("writes OPENROUTER_API_KEY from credentials/openrouter into .env before deploy", async () => {
    const skillTentacleDir = path.join(dir, "skills", "mapped-env")
    fs.mkdirSync(path.join(skillTentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(skillTentacleDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(skillTentacleDir, "SKILL.md"), "---\nname: mapped-env\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n      requires:\n        env:\n          - OPENROUTER_API_KEY\n---\n")
    fs.writeFileSync(path.join(skillTentacleDir, "README.md"), "# Deploy\n## Environment\nOPENROUTER_API_KEY is required.\n## Deploy Steps\n1. Install deps.\n## Start Command\n```bash\npython3 src/main.py\n```\n")
    fs.writeFileSync(path.join(skillTentacleDir, "prompt", "SYSTEM.md"), "# Identity\nYou are mapped-env.\n\n# Mission\nUse the injected OpenRouter credential to perform LLM-backed work and register with OpenCeph after deployment.")
    fs.writeFileSync(path.join(skillTentacleDir, "src", "main.py"), "# main\n")

    const skillEntry = {
      name: "mapped-env",
      path: skillTentacleDir,
      description: "Mapped env",
      spawnable: true,
      isSkillTentacle: true,
      skillTentacleConfig: {
        spawnable: true as const,
        runtime: "python" as const,
        entry: "src/main.py",
        defaultTrigger: "self",
        setupCommands: [],
        requires: { bins: [], env: ["OPENROUTER_API_KEY"] },
        capabilities: [],
      },
    }

    const codeAgent = mockCodeAgent()
    const manager = mockTentacleManager()
    ;(manager as any).getTentacleBaseDir = () => path.join(dir, "tentacles")
    ;(manager as any).getStatus = vi.fn().mockReturnValue({ pid: 23456 })
    const credentialStore = mockCredentialStore({ openrouter: "sk-or-test-value" })
    const spawner = new SkillSpawner(
      makeConfig(),
      mockSkillLoader([skillEntry]),
      manager,
      codeAgent,
      credentialStore,
    )

    const result = await spawner.spawn({
      mode: "deploy",
      skillName: "mapped-env",
      tentacleId: "t_mapped_env",
      purpose: "test",
      workflow: "test",
      userConfirmed: true,
    })

    expect(result.success).toBe(true)
    const envFile = fs.readFileSync(path.join(dir, "tentacles", "t_mapped_env", ".env"), "utf-8")
    expect(envFile).toContain("OPENROUTER_API_KEY=sk-or-test-value")
    // Scene A (deploy): NEVER calls Code Agent
    expect(codeAgent.deployExisting).not.toHaveBeenCalled()
    expect((credentialStore.get as any).mock.calls.map((call: [string]) => call[0])).toContain("openrouter")
  })

  it("resolves OPENROUTER_API_KEY from openceph.json model/auth config", async () => {
    const skillTentacleDir = path.join(dir, "skills", "config-env")
    fs.mkdirSync(path.join(skillTentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(skillTentacleDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(skillTentacleDir, "SKILL.md"), "---\nname: config-env\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n      requires:\n        env:\n          - OPENROUTER_API_KEY\n---\n")
    fs.writeFileSync(path.join(skillTentacleDir, "README.md"), "# Deploy\n## Environment\nRuntime LLM config is injected.\n## Deploy Steps\n1. Install deps.\n## Start Command\n```bash\npython3 src/main.py\n```\n")
    fs.writeFileSync(path.join(skillTentacleDir, "prompt", "SYSTEM.md"), "# Identity\nYou are config-env.\n\n# Mission\nUse the runtime LLM configuration injected from openceph.json and start normally under OpenCeph.")
    fs.writeFileSync(path.join(skillTentacleDir, "src", "main.py"), "# main\n")

    const skillEntry = {
      name: "config-env",
      path: skillTentacleDir,
      description: "Config env",
      spawnable: true,
      isSkillTentacle: true,
      skillTentacleConfig: {
        spawnable: true as const,
        runtime: "python" as const,
        entry: "src/main.py",
        defaultTrigger: "self",
        setupCommands: [],
        requires: { bins: [], env: ["OPENROUTER_API_KEY"] },
        capabilities: [],
      },
    }

    const codeAgent = mockCodeAgent()
    const manager = mockTentacleManager()
    ;(manager as any).getTentacleBaseDir = () => path.join(dir, "tentacles")
    ;(manager as any).getStatus = vi.fn().mockReturnValue({ pid: 45678 })
    const config = makeConfig()
    config.models = {
      providers: {
        openrouter: {
          baseUrl: "https://brain.example/v1",
          api: "openai-completions",
        },
      },
      named: {},
    }
    config.auth = {
      profiles: {
        "openrouter:primary": {
          mode: "api_key",
          apiKey: "sk-brain-value",
        },
      },
      order: {
        openrouter: ["openrouter:primary"],
      },
    }
    config.agents.defaults.model = {
      primary: "openrouter/anthropic/claude-opus-4-6",
      fallbacks: [],
    }
    config.agents.defaults.models = {
      "openrouter/anthropic/claude-opus-4-6": {
        params: { temperature: 0.9 },
      },
    }
    config.tentacle.model = {
      primary: "openrouter/anthropic/claude-haiku-4-5",
      fallbacks: [],
    }
    config.tentacle.models = {
      "openrouter/anthropic/claude-haiku-4-5": {
        params: { temperature: 0.4 },
      },
    }
    config.tentacle.providers = {
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
      },
    }
    config.tentacle.auth = {
      profiles: {
        "openrouter:tentacle": {
          mode: "api_key",
          apiKey: "sk-config-value",
        },
      },
      order: {
        openrouter: ["openrouter:tentacle"],
      },
    }

    const spawner = new SkillSpawner(config, mockSkillLoader([skillEntry]), manager, codeAgent)

    const result = await spawner.spawn({
      mode: "deploy",
      skillName: "config-env",
      tentacleId: "t_config_env",
      purpose: "test",
      workflow: "test",
      userConfirmed: true,
    })

    expect(result.success).toBe(true)
    const envFile = fs.readFileSync(path.join(dir, "tentacles", "t_config_env", ".env"), "utf-8")
    expect(envFile).toContain("OPENROUTER_API_KEY=sk-config-value")
    expect(envFile).toContain("OPENROUTER_MODEL=anthropic/claude-haiku-4-5")
    expect(envFile).toContain("OPENCEPH_LLM_BASE_URL=https://openrouter.ai/api/v1")
    expect(envFile).toContain("OPENCEPH_LLM_PARAMS_JSON={\"temperature\":0.4}")
    expect(envFile).not.toContain("sk-brain-value")
    expect(envFile).not.toContain("https://brain.example/v1")
  })

  it("uses the README start command when writing tentacle.json", async () => {
    const skillTentacleDir = path.join(dir, "skills", "readme-command")
    fs.mkdirSync(path.join(skillTentacleDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(skillTentacleDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(skillTentacleDir, "SKILL.md"), "---\nname: readme-command\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n---\n")
    fs.writeFileSync(path.join(skillTentacleDir, "README.md"), "# Deploy\n\n## Start Command\n\n```bash\n# Spawned by OpenCeph runtime:\npython3 src/main.py\n\n# Dry-run mode:\npython3 src/main.py --dry-run\n```\n")
    fs.writeFileSync(path.join(skillTentacleDir, "prompt", "SYSTEM.md"), "# Identity\nYou are readme-command.\n\n# Mission\nUse the README start command.")
    fs.writeFileSync(path.join(skillTentacleDir, "src", "main.py"), "# main\n")

    const skillEntry = {
      name: "readme-command",
      path: skillTentacleDir,
      description: "README command",
      spawnable: true,
      isSkillTentacle: true,
      skillTentacleConfig: {
        spawnable: true as const,
        runtime: "python" as const,
        entry: "src/main.py",
        defaultTrigger: "self",
        setupCommands: [],
        requires: { bins: [], env: [] },
        capabilities: [],
      },
    }

    const codeAgent = mockCodeAgent()
    const manager = mockTentacleManager()
    ;(manager as any).getTentacleBaseDir = () => path.join(dir, "tentacles")
    ;(manager as any).getStatus = vi.fn().mockReturnValue({ pid: 4321 })
    const spawner = new SkillSpawner(makeConfig(), mockSkillLoader([skillEntry]), manager, codeAgent)

    const result = await spawner.spawn({
      mode: "deploy",
      skillName: "readme-command",
      tentacleId: "t_readme_command",
      purpose: "test",
      workflow: "test",
      userConfirmed: true,
    })

    expect(result.success).toBe(true)
    const tentacleJson = JSON.parse(
      fs.readFileSync(path.join(dir, "tentacles", "t_readme_command", "tentacle.json"), "utf-8"),
    )
    expect(tentacleJson.entryCommand).toBe("python3 src/main.py")
  })

  it("recovers with a fresh validation pass after retries report stale failure", async () => {
    const manager = mockTentacleManager()
    ;(manager as any).getTentacleBaseDir = () => path.join(dir, "tentacles")
    ;(manager as any).getStatus = vi.fn().mockReturnValue({ pid: 321 })
    const runtimeDir = path.join(dir, "tentacles", "t_recover")
    fs.mkdirSync(path.join(runtimeDir, "prompt"), { recursive: true })
    fs.mkdirSync(path.join(runtimeDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(runtimeDir, "SKILL.md"), "---\nname: t_recover\nmetadata:\n  openceph:\n    tentacle:\n      spawnable: true\n      runtime: python\n      entry: src/main.py\n---\n")
    fs.writeFileSync(path.join(runtimeDir, "README.md"), "# Deploy\n## Env\n## Steps\n")
    fs.writeFileSync(path.join(runtimeDir, "prompt", "SYSTEM.md"), "# Identity\nRecover test.\n\n# Mission\nRecover validation state.")
    fs.writeFileSync(path.join(runtimeDir, "src", "main.py"), "print('ok')\n")

    const artifact = {
      sessionFile: path.join(dir, "code-agent.jsonl"),
      workDir: path.join(dir, "work"),
      logsDir: path.join(dir, "agent-logs"),
      terminalLog: path.join(dir, "agent-logs", "terminal.log"),
      stdoutLog: path.join(dir, "agent-logs", "stdout.log"),
      stderrLog: path.join(dir, "agent-logs", "stderr.log"),
      elapsedMs: 10,
      turnCount: 1,
      toolCalls: [],
    }
    const codeAgent = {
      generateSkillTentacle: vi.fn().mockResolvedValue(artifact),
      fixSkillTentacle: vi.fn().mockResolvedValue(artifact),
      deployExisting: vi.fn().mockResolvedValue(artifact),
    } as any
    const spawner = new SkillSpawner(makeConfig(), mockSkillLoader(), manager, codeAgent)

    const validateSpy = vi.spyOn(TentacleValidator.prototype, "validateSkillTentacle")
    validateSpy
      .mockResolvedValueOnce({
        passed: false,
        checks: {
          structure: { passed: false, errors: [{ check: "structure", message: "frontmatter missing" }], warnings: [] },
          syntax: { passed: true, errors: [], warnings: [] },
          contract: { passed: true, errors: [], warnings: [] },
          security: { passed: true, errors: [], warnings: [] },
          smoke: { passed: true, errors: [], warnings: [] },
        },
      } as any)
      .mockResolvedValueOnce({
        passed: false,
        checks: {
          structure: { passed: false, errors: [{ check: "structure", message: "frontmatter missing" }], warnings: [] },
          syntax: { passed: true, errors: [], warnings: [] },
          contract: { passed: true, errors: [], warnings: [] },
          security: { passed: true, errors: [], warnings: [] },
          smoke: { passed: true, errors: [], warnings: [] },
        },
      } as any)
      .mockResolvedValueOnce({
        passed: false,
        checks: {
          structure: { passed: false, errors: [{ check: "structure", message: "frontmatter missing" }], warnings: [] },
          syntax: { passed: true, errors: [], warnings: [] },
          contract: { passed: true, errors: [], warnings: [] },
          security: { passed: true, errors: [], warnings: [] },
          smoke: { passed: true, errors: [], warnings: [] },
        },
      } as any)
      .mockResolvedValueOnce({
        passed: true,
        checks: {
          structure: { passed: true, errors: [], warnings: [] },
          syntax: { passed: true, errors: [], warnings: [] },
          contract: { passed: true, errors: [], warnings: [] },
          security: { passed: true, errors: [], warnings: [] },
          smoke: { passed: true, errors: [], warnings: [] },
        },
      } as any)

    const result = await spawner.spawn({
      mode: "create",
      tentacleId: "t_recover",
      purpose: "recover test",
      workflow: "recover test workflow",
      userConfirmed: true,
    })

    expect(result.success).toBe(true)
    expect(result.spawned).toBe(true)
    expect(result.codeAgentSessionFile).toBe(artifact.sessionFile)
    expect(codeAgent.fixSkillTentacle).toHaveBeenCalledTimes(2)
    expect(codeAgent.deployExisting).toHaveBeenCalledTimes(1)
  })
})
