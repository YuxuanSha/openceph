#!/usr/bin/env node

import { Command } from "commander"
import * as fs from "fs/promises"
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from "fs"
import * as path from "path"
import * as os from "os"
import * as crypto from "crypto"
import * as readline from "readline"
import { loadConfig } from "./config/config-loader.js"
import { CredentialStore } from "./config/credential-store.js"
import { createPiContext } from "./pi/pi-context.js"
import { initLoggers } from "./logger/index.js"
import { initProcessRuntimeCapture } from "./logger/process-runtime-capture.js"
import { fileURLToPath } from "url"
import { CronStore } from "./cron/cron-store.js"
import { CronRunner } from "./cron/cron-runner.js"
import { CronScheduler } from "./cron/cron-scheduler.js"
import { parseDurationMs } from "./cron/time.js"
import { SessionStoreManager } from "./session/session-store.js"
import { readRuntimeStatus } from "./logger/runtime-status-store.js"
import { systemLogger } from "./logger/index.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const OPENCEPH_HOME = path.join(os.homedir(), ".openceph")
const CREDENTIALS_DIR = path.join(OPENCEPH_HOME, "credentials")

const program = new Command()

program
  .name("openceph")
  .description("OpenCeph — AI Personal Operating System")
  .version("0.1.0")

async function createCronServices() {
  const config = loadConfig()
  initLoggers(config)
  const piCtx = await createPiContext(config)
  const { Brain } = await import("./brain/brain.js")
  const brain = new Brain({ config, piCtx })
  await brain.initialize()
  const store = new CronStore(config.cron.store)
  const runner = new CronRunner(
    piCtx,
    config,
    brain,
    null,
    store,
    new SessionStoreManager("cron"),
  )
  const scheduler = new CronScheduler(config, store, runner)
  await scheduler.start()
  await brain.registerCronScheduler(scheduler)
  return {
    scheduler,
    async shutdown() {
      scheduler.stop()
      await brain.shutdown()
    },
  }
}

// ─── openceph-runtime preinstall ─────────────────────────────────

async function initOpencephRuntime(): Promise<void> {
  const { exec } = await import("child_process")
  const { promisify } = await import("util")
  const execAsync = promisify(exec)

  // Find openceph-runtime source — try dist/ first, then src/ (dev)
  const runtimeSrcDir = [
    path.join(__dirname, "..", "packages", "openceph-runtime"),
    path.join(__dirname, "..", "..", "packages", "openceph-runtime"),
  ].find((p) => existsSync(path.join(p, "pyproject.toml")))

  if (!runtimeSrcDir) {
    console.warn("  ⚠ openceph-runtime source not found, skipping preinstall")
    return
  }

  const packagesDir = path.join(OPENCEPH_HOME, "packages")
  await fs.mkdir(packagesDir, { recursive: true })

  console.log("  Building openceph-runtime package...")
  try {
    // Try building a wheel first (fastest install later)
    await execAsync(
      `python3 -m pip wheel --no-deps --wheel-dir "${packagesDir}" "${runtimeSrcDir}"`,
      { timeout: 60_000 },
    )
    console.log("  ✓ openceph-runtime wheel built")
  } catch {
    // Wheel build needs network (for setuptools). Fallback: build sdist tarball locally.
    try {
      await execAsync(
        `cd "${runtimeSrcDir}" && python3 -m build --sdist --outdir "${packagesDir}"`,
        { timeout: 60_000 },
      )
      console.log("  ✓ openceph-runtime sdist built")
    } catch {
      // Last resort: copy source so skill-spawner can pip install from it
      console.warn("  ⚠ package build failed, copying source as fallback")
      const fallbackDir = path.join(packagesDir, "openceph-runtime")
      await fs.rm(fallbackDir, { recursive: true, force: true }).catch(() => {})
      await fs.cp(runtimeSrcDir, fallbackDir, { recursive: true })
      console.log("  ✓ openceph-runtime source copied to packages/")
    }
  }
}

// ─── openceph init ───────────────────────────────────────────────

program
  .command("init")
  .description("Initialize OpenCeph at ~/.openceph/")
  .action(async () => {
    const dirs = [
      OPENCEPH_HOME,
      path.join(OPENCEPH_HOME, "workspace"),
      path.join(OPENCEPH_HOME, "workspace", "memory"),
      path.join(OPENCEPH_HOME, "workspace", "skills"),
      CREDENTIALS_DIR,
      path.join(OPENCEPH_HOME, "brain"),
      path.join(OPENCEPH_HOME, "agents"),
      path.join(OPENCEPH_HOME, "tentacles"),
      path.join(OPENCEPH_HOME, "logs"),
      path.join(OPENCEPH_HOME, "skills"),
      path.join(OPENCEPH_HOME, "state"),
    ]

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
    }

    // Copy openceph.json template
    const configDest = path.join(OPENCEPH_HOME, "openceph.json")
    const configSrc = path.join(__dirname, "templates", "openceph.json")
    // Try to find templates relative to source (dev) or dist (built)
    const configSrcAlt = path.join(__dirname, "..", "src", "templates", "openceph.json")
    const actualConfigSrc = existsSync(configSrc) ? configSrc : configSrcAlt

    if (!existsSync(configDest)) {
      if (existsSync(actualConfigSrc)) {
        copyFileSync(actualConfigSrc, configDest)
      } else {
        console.error(`Template not found: ${configSrc}`)
        process.exit(1)
      }
    }

    // Copy workspace templates
    const workspaceDest = path.join(OPENCEPH_HOME, "workspace")
    const workspaceSrc = path.join(__dirname, "templates", "workspace")
    const workspaceSrcAlt = path.join(__dirname, "..", "src", "templates", "workspace")
    const actualWorkspaceSrc = existsSync(workspaceSrc) ? workspaceSrc : workspaceSrcAlt

    if (existsSync(actualWorkspaceSrc)) {
      const templateFiles = await fs.readdir(actualWorkspaceSrc)
      for (const file of templateFiles) {
        const dest = path.join(workspaceDest, file)
        if (!existsSync(dest)) {
          copyFileSync(path.join(actualWorkspaceSrc, file), dest)
        }
      }

      // Version-aware migration: overwrite managed prompt files when template version changes
      const TEMPLATE_VERSION = "1.0.2"
      const versionFile = path.join(workspaceDest, ".template-version")
      let currentVersion = ""
      try { currentVersion = readFileSync(versionFile, "utf-8").trim() } catch {}
      if (currentVersion !== TEMPLATE_VERSION) {
        // Managed files: system-owned prompt templates that should be updated on upgrade
        // NOT migrated: USER.md, MEMORY.md (user data), TOOLS.md (auto-generated), TENTACLES.md (live registry)
        const managedFiles = ["AGENTS.md", "SOUL.md", "CONSULTATION.md", "HEARTBEAT.md", "IDENTITY.md", "BOOTSTRAP.md"]
        for (const file of managedFiles) {
          const src = path.join(actualWorkspaceSrc, file)
          const dest = path.join(workspaceDest, file)
          if (existsSync(src)) {
            copyFileSync(src, dest)
          }
        }
        writeFileSync(versionFile, TEMPLATE_VERSION, "utf-8")
      }
    } else {
      console.error(`Workspace templates not found: ${workspaceSrc}`)
      process.exit(1)
    }

    const skillsDest = path.join(OPENCEPH_HOME, "skills")
    const skillsSrc = path.join(__dirname, "templates", "skills")
    const skillsSrcAlt = path.join(__dirname, "..", "src", "templates", "skills")
    const actualSkillsSrc = existsSync(skillsSrc) ? skillsSrc : skillsSrcAlt
    if (existsSync(actualSkillsSrc)) {
      const skillDirs = await fs.readdir(actualSkillsSrc)
      for (const skillDir of skillDirs) {
        const destDir = path.join(skillsDest, skillDir)
        await copyDirIfMissing(path.join(actualSkillsSrc, skillDir), destDir)
      }
    }

    const config = loadConfig()

    // Initialize loggers before any code that might use systemLogger
    initLoggers(config)

    if (config.builtinTentacles?.autoInstallOnInit !== false) {
      await initBuiltinTentacles(skillsDest, config.builtinTentacles?.skipList ?? [])
    }

    // Copy contracts to ~/.openceph/contracts/
    await installContracts()

    // Pre-install openceph-runtime for Python tentacles
    await initOpencephRuntime()

    // Generate gateway token
    const tokenPath = path.join(CREDENTIALS_DIR, "gateway_token")
    if (!existsSync(tokenPath)) {
      const token = crypto.randomUUID()
      await fs.writeFile(tokenPath, token, { mode: 0o600 })
    }

    // Set credentials directory permissions
    await fs.chmod(CREDENTIALS_DIR, 0o700)

    console.log(`OpenCeph initialized at ${OPENCEPH_HOME}/`)
    console.log("")
    console.log("Next steps:")
    console.log("  1. openceph credentials set openrouter <YOUR_API_KEY>")
    console.log("  2. openceph start  (verify config)")
    console.log('  3. openceph chat   (M1 阶段可用)')
  })

program
  .command("upgrade")
  .description("Upgrade builtin tentacles without overwriting prompt customizations")
  .action(async () => {
    const config = loadConfig()
    initProcessRuntimeCapture(config.logging.logDir, "ceph")
    initLoggers(config)
    const skillsDest = path.join(OPENCEPH_HOME, "skills")
    await fs.mkdir(skillsDest, { recursive: true })
    if (config.builtinTentacles?.autoUpgradeOnUpdate !== false) {
      await upgradeBuiltinTentacles(skillsDest, config.builtinTentacles?.skipList ?? [])
    }
    // Refresh contracts to latest version
    await refreshContracts()
    // Re-build openceph-runtime wheel (new tentacles will pick up the update)
    await initOpencephRuntime()
    console.log(`Builtin tentacles synced in ${skillsDest}`)
    console.log(`Contracts refreshed in ${path.join(OPENCEPH_HOME, "contracts")}`)
    console.log(`openceph-runtime updated in ${path.join(OPENCEPH_HOME, "packages")}`)
  })

// ─── openceph start ──────────────────────────────────────────────

program
  .command("start")
  .description("Start OpenCeph (Gateway + Brain + all channels)")
  .action(async () => {
    try {
      const { startOpenCeph } = await import("./main.js")
      await startOpenCeph()
    } catch (err) {
      console.error("Failed to start OpenCeph:")
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

// ─── openceph chat ──────────────────────────────────────────────

program
  .command("chat")
  .description("Start a CLI chat session with Ceph (no Gateway)")
  .action(async () => {
    const config = loadConfig()
    initLoggers(config)

    try {
      const piCtx = await createPiContext(config)
      const { Brain } = await import("./brain/brain.js")
      const { McpBridge } = await import("./mcp/mcp-bridge.js")
      const brain = new Brain({ config, piCtx })
      await brain.initialize()
      const mcpBridge = new McpBridge(config)
      await mcpBridge.init()
      await brain.registerTools(mcpBridge.getTools())

      const { CommandHandler } = await import("./gateway/commands/command-handler.js")
      const { newCommand, stopCommand, compactCommand } = await import("./gateway/commands/session.js")
      const { statusCommand, whoamiCommand } = await import("./gateway/commands/status.js")
      const { helpCommand } = await import("./gateway/commands/help.js")
      const { modelCommand, thinkCommand, reasoningCommand } = await import("./gateway/commands/model.js")
      const { tentaclesCommand, tentacleCommand } = await import("./gateway/commands/tentacle.js")
      const { cronCommand } = await import("./gateway/commands/cron.js")
      const { contextCommand } = await import("./gateway/commands/context.js")
      const { skillCommand } = await import("./gateway/commands/skill.js")

      const cmdHandler = new CommandHandler()
      cmdHandler.register("/new", newCommand)
      cmdHandler.register("/reset", newCommand)
      cmdHandler.register("/stop", stopCommand)
      cmdHandler.register("/compact", compactCommand)
      cmdHandler.register("/status", statusCommand)
      cmdHandler.register("/whoami", whoamiCommand)
      cmdHandler.register("/help", helpCommand)
      cmdHandler.register("/model", modelCommand)
      cmdHandler.register("/think", thinkCommand)
      cmdHandler.register("/reasoning", reasoningCommand)
      cmdHandler.register("/tentacles", tentaclesCommand)
      cmdHandler.register("/tentacle", tentacleCommand)
      cmdHandler.register("/cron", cronCommand)
      cmdHandler.register("/context", contextCommand)
      cmdHandler.register("/skill", skillCommand)

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const sessionKey = `agent:ceph:${config.session.mainKey}`

      console.log("🐙 Ceph ready. Type /help for commands, /exit to quit.")

      const ask = () => {
        rl.question("> ", async (text) => {
          if (!text?.trim()) { ask(); return }
          if (text.trim() === "/exit" || text.trim() === "/quit") {
            await mcpBridge.shutdown()
            await brain.shutdown()
            rl.close()
            process.exit(0)
          }

          // Check for commands
          const cmdResult = await cmdHandler.execute(text.trim(), {
            channel: "cli",
            senderId: "cli:local",
            sessionKey,
            brain,
            config,
          })
          if (cmdResult !== null) {
            console.log(cmdResult)
            console.log()
            ask()
            return
          }

          // Send to brain with streaming
          try {
            const output = await brain.handleMessage({
              text: text.trim(),
              channel: "cli",
              senderId: "cli:local",
              sessionKey,
              isDm: true,
              onTextDelta: (delta) => process.stdout.write(delta),
            })
            // If streaming didn't output, print the full response
            if (!output.text) {
              console.log("[No response]")
            }
            console.log()
          } catch (err: any) {
            console.error(`Error: ${err.message}`)
          }
          ask()
        })
      }
      ask()
    } catch (err) {
      console.error("Failed to start chat:")
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

// ─── openceph pairing ───────────────────────────────────────────

const pairCmd = program
  .command("pairing")
  .description("Manage channel pairing (approve/reject users)")

pairCmd
  .command("list")
  .description("List all pairing entries")
  .action(async () => {
    const { PairingManager } = await import("./gateway/pairing.js")
    const statePath = path.join(OPENCEPH_HOME, "state", "pairing.json")
    const pm = new PairingManager(statePath)
    const entries = await pm.list()
    if (entries.length === 0) {
      console.log("No pending pairing entries.")
    } else {
      console.log("Pending:")
      for (const p of entries) {
        console.log(`  [${p.code}] ${p.channel}:${p.senderId} (expires ${p.expiresAt})`)
      }
    }
  })

pairCmd
  .command("approve <code>")
  .description("Approve a pending pairing request by code")
  .action(async (code: string) => {
    const { PairingManager } = await import("./gateway/pairing.js")
    const statePath = path.join(OPENCEPH_HOME, "state", "pairing.json")
    const pm = new PairingManager(statePath)
    const result = await pm.approve(code)
    if (result) {
      console.log(`Pairing approved: ${code}`)
    } else {
      console.error(`Pairing code not found or expired: ${code}`)
      process.exit(1)
    }
  })

pairCmd
  .command("reject <code>")
  .description("Reject a pending pairing request by code")
  .action(async (code: string) => {
    const { PairingManager } = await import("./gateway/pairing.js")
    const statePath = path.join(OPENCEPH_HOME, "state", "pairing.json")
    const pm = new PairingManager(statePath)
    const result = await pm.reject(code)
    if (result) {
      console.log(`Pairing rejected: ${code}`)
    } else {
      console.error(`Pairing code not found: ${code}`)
      process.exit(1)
    }
  })

pairCmd
  .command("revoke <channel> <senderId>")
  .description("Revoke an approved pairing")
  .action(async (channel: string, senderId: string) => {
    const { PairingManager } = await import("./gateway/pairing.js")
    const statePath = path.join(OPENCEPH_HOME, "state", "pairing.json")
    const pm = new PairingManager(statePath)
    const result = await pm.revoke(channel, senderId)
    if (result) {
      console.log(`Pairing revoked: ${channel}:${senderId}`)
    } else {
      console.error(`Approved pairing not found: ${channel}:${senderId}`)
      process.exit(1)
    }
  })

// ─── openceph credentials ────────────────────────────────────────

const credCmd = program
  .command("credentials")
  .description("Manage credentials")

credCmd
  .command("set <key> [value]")
  .description("Set a credential value")
  .option("--keychain <service>", "Store in system keychain")
  .action(async (key: string, value: string | undefined, opts: { keychain?: string }) => {
    const store = new CredentialStore(CREDENTIALS_DIR)

    if (!value) {
      // Read from stdin
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      value = await new Promise<string>((resolve) => {
        rl.question("Enter value: ", (answer) => {
          rl.close()
          resolve(answer)
        })
      })
    }

    if (opts.keychain) {
      store.setKeychain(opts.keychain, key, value)
      console.log(`Credential stored in keychain: ${opts.keychain}/${key}`)
    } else {
      await store.set(key, value)
      console.log(`Credential stored: ${key}`)
    }
  })

credCmd
  .command("get <key>")
  .description("Get a credential value")
  .action(async (key: string) => {
    const store = new CredentialStore(CREDENTIALS_DIR)
    try {
      const value = await store.get(key)
      console.log(value)
    } catch {
      console.error(`Credential not found: ${key}`)
      process.exit(1)
    }
  })

credCmd
  .command("list")
  .description("List all credentials")
  .action(async () => {
    const store = new CredentialStore(CREDENTIALS_DIR)
    const keys = await store.list()
    if (keys.length === 0) {
      console.log("No credentials configured.")
    } else {
      for (const key of keys) {
        console.log(key)
      }
    }
  })

credCmd
  .command("delete <key>")
  .description("Delete a credential")
  .action(async (key: string) => {
    const store = new CredentialStore(CREDENTIALS_DIR)
    try {
      await store.delete(key)
      console.log(`Credential deleted: ${key}`)
    } catch {
      console.error(`Credential not found: ${key}`)
      process.exit(1)
    }
  })

// ─── openceph cron ──────────────────────────────────────────────

const cronCmd = program
  .command("cron")
  .description("Manage cron jobs")

cronCmd
  .command("list")
  .description("List cron jobs")
  .action(async () => {
    const services = await createCronServices()
    try {
      const jobs = services.scheduler.listJobs()
      if (jobs.length === 0) {
        console.log("No cron jobs.")
        return
      }
      for (const job of jobs) {
        console.log(`${job.jobId} | ${job.enabled ? "enabled" : "disabled"} | ${job.sessionTarget} | next=${job.nextRunAt ?? "-"} | ${job.name}`)
      }
    } finally {
      await services.shutdown()
    }
  })

cronCmd
  .command("add")
  .description("Add a cron job")
  .requiredOption("--name <name>", "Job name")
  .option("--cron <expr>", "Cron expression")
  .option("--every <duration>", "Fixed interval, e.g. 4h")
  .option("--at <time>", "ISO timestamp or relative duration like 20m")
  .option("--tz <timezone>", "IANA timezone")
  .option("--session <target>", "main or isolated", "isolated")
  .option("--message <message>", "Prompt message")
  .option("--system-event <text>", "Main-session system event")
  .option("--wake <mode>", "now or next-heartbeat", "next-heartbeat")
  .option("--announce", "Announce result")
  .option("--channel <channel>", "Delivery channel", "last")
  .option("--model <model>", "Model override")
  .option("--delete-after-run", "Delete after run")
  .action(async (opts: any) => {
    const services = await createCronServices()
    try {
      const schedule = buildScheduleFromOptions(opts)
      const sessionTarget = opts.session === "main" ? "main" : "isolated"
      const message = opts.systemEvent ?? opts.message
      if (!message) {
        throw new Error("Either --message or --system-event is required")
      }
      const job = await services.scheduler.addJob({
        name: opts.name,
        schedule,
        sessionTarget,
        wakeMode: opts.wake,
        payload: sessionTarget === "main"
          ? { kind: "systemEvent", text: message }
          : { kind: "agentTurn", message },
        delivery: opts.announce ? { mode: "announce", channel: opts.channel } : { mode: "none" },
        model: opts.model,
        deleteAfterRun: Boolean(opts.deleteAfterRun),
      })
      console.log(`Created cron job: ${job.jobId}`)
    } finally {
      await services.shutdown()
    }
  })

cronCmd
  .command("edit <jobId>")
  .description("Edit a cron job")
  .option("--cron <expr>", "Cron expression")
  .option("--every <duration>", "Fixed interval")
  .option("--at <time>", "At time")
  .option("--tz <timezone>", "Timezone")
  .option("--message <message>", "Message update")
  .option("--model <model>", "Model override")
  .option("--disable", "Disable job")
  .option("--enable", "Enable job")
  .action(async (jobId: string, opts: any) => {
    const services = await createCronServices()
    try {
      const patch: any = {}
      if (opts.cron || opts.every || opts.at) {
        patch.schedule = buildScheduleFromOptions(opts)
      }
      if (opts.message) patch.message = opts.message
      if (opts.model) patch.model = opts.model
      if (opts.disable) patch.enabled = false
      if (opts.enable) patch.enabled = true
      await services.scheduler.updateJob(jobId, patch)
      console.log(`Updated cron job: ${jobId}`)
    } finally {
      await services.shutdown()
    }
  })

cronCmd
  .command("remove <jobId>")
  .description("Remove a cron job")
  .action(async (jobId: string) => {
    const services = await createCronServices()
    try {
      const removed = await services.scheduler.removeJob(jobId)
      console.log(removed ? `Removed cron job: ${jobId}` : `Cron job not found: ${jobId}`)
    } finally {
      await services.shutdown()
    }
  })

cronCmd
  .command("run <jobId>")
  .description("Run a cron job now")
  .action(async (jobId: string) => {
    const services = await createCronServices()
    try {
      await services.scheduler.runJob(jobId, "force")
      console.log(`Triggered cron job: ${jobId}`)
    } finally {
      await services.shutdown()
    }
  })

cronCmd
  .command("runs")
  .description("Show cron run history")
  .requiredOption("--id <jobId>", "Job id")
  .option("--limit <n>", "Limit", "20")
  .action(async (opts: any) => {
    const services = await createCronServices()
    try {
      const runs = await services.scheduler.getRunHistory(opts.id, Number(opts.limit))
      if (runs.length === 0) {
        console.log("No runs found.")
        return
      }
      for (const run of runs) {
        console.log(`${run.startedAt} | ${run.status} | ${run.error ?? "-"}`)
      }
    } finally {
      await services.shutdown()
    }
  })

// ─── openceph tentacle ──────────────────────────────────────────

const tentacleCmd = program
  .command("tentacle")
  .description("Manage skill_tentacle packages")

tentacleCmd
  .command("pack <tentacleId>")
  .description("Package a deployed tentacle as a shareable .tentacle file")
  .option("-o, --output <dir>", "Output directory")
  .action(async (tentacleId: string, opts: { output?: string }) => {
    try {
      const { TentaclePackager } = await import("./skills/tentacle-packager.js")
      const packager = new TentaclePackager(loadConfig().skillTentacle.packExclude)
      const outputPath = await packager.pack(tentacleId, opts.output)
      console.log(`Packaged: ${outputPath}`)
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

tentacleCmd
  .command("install <source>")
  .description("Install a skill_tentacle from .tentacle file, github:user/repo/path, or local directory")
  .action(async (source: string) => {
    try {
      const { TentaclePackager } = await import("./skills/tentacle-packager.js")
      const packager = new TentaclePackager(loadConfig().skillTentacle.packExclude)
      const targetDir = await packager.install(source)
      console.log(`Installed to: ${targetDir}`)

      // Validate the installed skill_tentacle
      const { TentacleValidator } = await import("./code-agent/validator.js")
      const validator = new TentacleValidator()
      const result = await validator.validateSkillTentacle(targetDir)
      if (result.passed) {
        console.log("Validation: PASSED")
      } else {
        console.log("Validation: FAILED")
        for (const check of Object.values(result.checks)) {
          for (const err of check.errors) {
            console.log(`  - ${err.message}`)
          }
        }
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

tentacleCmd
  .command("list")
  .description("List all installed skill_tentacle packages")
  .option("--installed", "List only installed skill_tentacles (default behavior)")
  .action(async () => {
    try {
      const { TentaclePackager } = await import("./skills/tentacle-packager.js")
      const packager = new TentaclePackager(loadConfig().skillTentacle.packExclude)
      const installed = await packager.listInstalled()
      if (installed.length === 0) {
        console.log("No skill_tentacle packages installed.")
        return
      }
      const nameW = Math.max(20, ...installed.map((i) => i.name.length)) + 2
      const versionW = 10
      const runtimeW = 12
      console.log(
        "  " + "NAME".padEnd(nameW) + "VERSION".padEnd(versionW) + "RUNTIME".padEnd(runtimeW) + "TYPE",
      )
      console.log("  " + "─".repeat(nameW + versionW + runtimeW + 16))
      for (const item of installed) {
        const type = item.isSkillTentacle ? "skill_tentacle" : "skill"
        console.log(
          "  " +
          item.name.padEnd(nameW) +
          (item.version ?? "—").padEnd(versionW) +
          (item.runtime ?? "—").padEnd(runtimeW) +
          type,
        )
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

tentacleCmd
  .command("info <name>")
  .description("Show details about an installed skill_tentacle")
  .action(async (name: string) => {
    try {
      const { TentaclePackager } = await import("./skills/tentacle-packager.js")
      const packager = new TentaclePackager(loadConfig().skillTentacle.packExclude)
      const info = await packager.info(name)
      if (!info) {
        console.log(`Not found: ${name}`)
        process.exit(1)
      }
      console.log(`\nName:        ${info.name}`)
      console.log(`Version:     ${info.version ?? "—"}`)
      console.log(`Description: ${info.description ?? "—"}`)
      console.log(`Runtime:     ${info.runtime ?? "—"}`)
      console.log(`Type:        ${info.isSkillTentacle ? "skill_tentacle" : "skill"}`)
      console.log(`Path:        ${info.path}`)

      const requires = info.requires as { bins?: string[]; env?: string[] } | undefined
      if (requires?.bins?.length) {
        console.log(`\nRequires (bins):`)
        for (const b of requires.bins) console.log(`  - ${b}`)
      }
      if (requires?.env?.length) {
        console.log(`\nRequires (env vars):`)
        for (const e of requires.env) console.log(`  - ${e}`)
      }

      const capabilities = info.capabilities as string[] | undefined
      if (capabilities?.length) {
        console.log(`\nCapabilities: ${capabilities.join(", ")}`)
      }

      const customizable = info.customizable as Array<{ field: string; description: string; type: string }> | undefined
      if (customizable?.length) {
        console.log(`\nCustomizable Fields:`)
        for (const f of customizable) {
          console.log(`  ${f.field.padEnd(24)} [${f.type}]  ${f.description}`)
        }
      }
      console.log()
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

tentacleCmd
  .command("validate <path>")
  .description("Validate a skill_tentacle directory")
  .action(async (targetPath: string) => {
    try {
      const { TentacleValidator } = await import("./code-agent/validator.js")
      const validator = new TentacleValidator()
      const absPath = path.resolve(targetPath)
      const result = await validator.validateSkillTentacle(absPath)
      if (result.passed) {
        console.log("Validation: PASSED")
      } else {
        console.log("Validation: FAILED")
        for (const [checkName, check] of Object.entries(result.checks)) {
          if (check.errors.length > 0) {
            console.log(`\n  [${checkName}]`)
            for (const err of check.errors) {
              console.log(`    - ${err.message}`)
            }
          }
          for (const w of check.warnings) {
            console.log(`    ⚠ ${w}`)
          }
        }
      }
      process.exit(result.passed ? 0 : 1)
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

// ─── openceph logs ───────────────────────────────────────────────

program
  .command("logs [type]")
  .description("View log files (brain|gateway|system|cost)")
  .option("--tail <n>", "Show last N lines", "50")
  .option("--follow", "Follow log output")
  .action(async (type: string | undefined, opts: { tail: string; follow?: boolean }) => {
    const config = loadConfig()
    const logDir = config.logging.logDir
    const logType = type || "brain"

    const validTypes = ["brain", "gateway", "system", "cost"]
    if (!validTypes.includes(logType)) {
      console.error(`Invalid log type: ${logType}. Valid types: ${validTypes.join(", ")}`)
      process.exit(1)
    }

    // Find the latest log file for this type
    let files: string[]
    try {
      files = await fs.readdir(logDir)
    } catch {
      console.error(`Log directory not found: ${logDir}`)
      process.exit(1)
      return
    }

    const logFiles = files
      .filter((f) => f.startsWith(`${logType}-`) && f.endsWith(".log"))
      .sort()
      .reverse()

    if (logFiles.length === 0) {
      console.log(`No ${logType} log files found.`)
      return
    }

    const latestFile = path.join(logDir, logFiles[0])
    const tailN = parseInt(opts.tail, 10) || 50

    try {
      const content = await fs.readFile(latestFile, "utf-8")
      const lines = content.trim().split("\n").slice(-tailN)

      for (const line of lines) {
        try {
          const obj = JSON.parse(line)
          const ts = obj.ts || obj.timestamp || ""
          const event = obj.event || obj.message || ""
          const rest = { ...obj }
          delete rest.ts
          delete rest.timestamp
          delete rest.event
          delete rest.message
          delete rest.level

          const extra = Object.keys(rest).length > 0
            ? " " + JSON.stringify(rest)
            : ""
          console.log(`[${ts}] [${event}]${extra}`)
        } catch {
          console.log(line)
        }
      }
    } catch {
      console.error(`Failed to read log file: ${latestFile}`)
      process.exit(1)
    }

    if (opts.follow) {
      // Simple follow mode using fs.watch
      const { watch } = await import("fs")
      let lastSize = 0
      try {
        const stat = await fs.stat(latestFile)
        lastSize = stat.size
      } catch { /* ignore */ }

      watch(latestFile, async () => {
        try {
          const stat = await fs.stat(latestFile)
          if (stat.size > lastSize) {
            const fd = await fs.open(latestFile, "r")
            const buf = Buffer.alloc(stat.size - lastSize)
            await fd.read(buf, 0, buf.length, lastSize)
            await fd.close()
            const newContent = buf.toString("utf-8")
            for (const line of newContent.trim().split("\n")) {
              if (!line) continue
              try {
                const obj = JSON.parse(line)
                const ts = obj.ts || obj.timestamp || ""
                const event = obj.event || obj.message || ""
                console.log(`[${ts}] [${event}]`)
              } catch {
                console.log(line)
              }
            }
            lastSize = stat.size
          }
        } catch { /* ignore */ }
      })

      // Keep process alive
      console.log("(Following... press Ctrl+C to stop)")
      await new Promise(() => {})
    }
  })

// ─── openceph status ─────────────────────────────────────────────

program
  .command("status")
  .description("Show OpenCeph system status")
  .action(async () => {
    try {
      const config = loadConfig()
      initLoggers(config)
      const snapshot = await readStatusSnapshot(config)

      console.log("OpenCeph Status")
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━")
      console.log(`Brain:    ${snapshot.brain.running ? `running (pid ${snapshot.brain.pid ?? "?"})` : "stopped"}${snapshot.brain.uptime ? ` (uptime: ${snapshot.brain.uptime})` : ""}`)
      console.log(`Model:    ${snapshot.model}`)
      console.log(`Session:  ${snapshot.session.sessionKey} (tokens: ${snapshot.session.totalTokens} in / ${snapshot.session.outputTokens} out)`)
      console.log(`Gateway:  ${snapshot.gateway.running ? `running (pid ${snapshot.gateway.pid ?? "?"})` : "stopped"}${snapshot.gateway.port ? ` (port ${snapshot.gateway.port})` : ""}`)
      console.log(`Channels: ${snapshot.channels.length > 0 ? snapshot.channels.join("  ") : "none active"}`)

      console.log()
      console.log(`Tentacles: ${snapshot.tentacles.running} running, ${snapshot.tentacles.weakened} weakened, ${snapshot.tentacles.crashed} crashed`)
      for (const t of snapshot.tentacles.items) {
        if (t.status === "killed") continue
        const healthStr = t.health ? ` (health: ${t.health})` : ""
        const lastReport = t.lastReport ? `, last report: ${t.lastReport}` : ""
        console.log(`  ${t.id.padEnd(24)} ${t.status.padEnd(10)}${healthStr}${lastReport}`)
      }

      console.log()
      console.log(`Pending Push: ${snapshot.pendingPush} items`)
      console.log(`Today's Cost: $${snapshot.todayCost.toFixed(2)} / $${config.cost.dailyLimitUsd} limit`)
      console.log(`Cache Hit Rate: ${snapshot.cacheStats.hitRate}%`)
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

// ─── openceph cost ──────────────────────────────────────────────

program
  .command("cost")
  .description("Show cost summary")
  .action(async () => {
    try {
      const config = loadConfig()
      const logDir = config.logging.logDir

      const todayCost = await readTodayCost(logDir)
      const weekCost = await readCostRange(logDir, 7)
      const monthCost = await readCostRange(logDir, 30)

      // Read cost breakdown by type
      const breakdown = await readCostBreakdown(logDir, 30)
      const cacheStats = await readCacheStats(logDir, 30)

      console.log("Cost Summary")
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━")
      console.log(`Today: $${todayCost.toFixed(2)} | This Week: $${weekCost.toFixed(2)} | This Month: $${monthCost.toFixed(2)}`)

      if (Object.keys(breakdown).length > 0) {
        const total = Object.values(breakdown).reduce((s, v) => s + v, 0)
        const parts = Object.entries(breakdown)
          .sort((a, b) => b[1] - a[1])
          .map(([type, cost]) => `${type} ${total > 0 ? ((cost / total) * 100).toFixed(0) : 0}%`)
        console.log(`By Type: ${parts.join(" | ")}`)
      }

      console.log(`Cache Savings: ${cacheStats.estimatedSavingsUsd.toFixed(2)} this month`)
      console.log(`Cache Hit Rate: ${cacheStats.hitRate}%`)
      console.log(`Daily Limit: $${config.cost.dailyLimitUsd}`)
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

// ─── openceph doctor ────────────────────────────────────────────

program
  .command("doctor")
  .description("Check system health and fix issues")
  .option("--fix", "Attempt to fix detected issues")
  .action(async (opts: { fix?: boolean }) => {
    try {
      const issues = await runDoctorChecks(Boolean(opts.fix))

      // Print results
      const fixableCount = issues.filter((i) => i.status !== "ok" && i.fixable).length
      for (const issue of issues) {
        const icon = issue.status === "ok" ? "✅" : issue.status === "warn" ? "⚠️" : "❌"
        console.log(`${icon} ${issue.check}: ${issue.message}`)
      }

      const errorCount = issues.filter((i) => i.status !== "ok").length
      if (errorCount === 0) {
        console.log("\nAll checks passed.")
      } else if (!opts.fix && fixableCount > 0) {
        console.log(`\nIssues: ${errorCount} → Run 'openceph doctor --fix' to auto-fix ${fixableCount}`)
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

// ─── openceph plugin ────────────────────────────────────────────

const pluginCmd = program
  .command("plugin")
  .description("Manage Extension Channel plugins")

pluginCmd
  .command("list")
  .description("List installed Extension Channel plugins")
  .action(async () => {
    try {
      const config = loadConfig()
      initLoggers(config)
      const { PluginLoader } = await import("./gateway/plugin-loader.js")
      const loader = new PluginLoader(process.cwd(), config.plugins)
      const discovered = await loader.discover()
      const pluginState = readPluginState()

      if (discovered.length === 0) {
        console.log("No Extension Channel plugins found.")
        console.log("Install one with: openceph plugin install <package>")
        return
      }

      console.log("Extension Channel Plugins")
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━")
      for (const plugin of discovered) {
        const loaded = pluginState.loaded.some((item) => item.channelId === plugin.channelId)
        console.log(`  ${plugin.displayName} (${plugin.packageName}@${plugin.version})${loaded ? " [loaded]" : ""}`)
        console.log(`    Channel ID: ${plugin.channelId}`)
        console.log(`    Entry: ${plugin.entryPath}`)
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })

pluginCmd
  .command("install <package>")
  .description("Install an Extension Channel plugin via npm")
  .action(async (pkg: string) => {
    try {
      const { execSync } = await import("child_process")
      console.log(`Installing ${pkg}...`)
      execSync(`npm install ${pkg}`, { stdio: "inherit", cwd: process.cwd() })

      const config = loadConfig()
      initLoggers(config)
      const { PluginLoader } = await import("./gateway/plugin-loader.js")
      const loader = new PluginLoader(process.cwd(), config.plugins)
      const discovered = await loader.discover()
      const installed = discovered.find((d) => d.packageName === pkg || d.packageName.endsWith(`/${pkg}`))

      if (installed) {
        await loader.load(installed)
        await writePluginOperation({ type: "install", packageName: installed.packageName, at: new Date().toISOString() })
        console.log(`\nPlugin installed: ${installed.displayName} (channel: ${installed.channelId})`)
        console.log("Gateway hot-reload signal emitted.")
      } else {
        console.log(`\nPackage installed but no openceph-channel plugin found.`)
        console.log(`Ensure the package has keywords: ["openceph-channel"] and openceph.channelPlugin in package.json.`)
      }
    } catch (err: any) {
      console.error(`Failed to install: ${err.message}`)
      process.exit(1)
    }
  })

pluginCmd
  .command("uninstall <package>")
  .description("Uninstall an Extension Channel plugin")
  .action(async (pkg: string) => {
    try {
      const { execSync } = await import("child_process")
      const config = loadConfig()
      initLoggers(config)
      const state = readPluginState()
      const loaded = state.loaded.find((item) => item.packageName === pkg || item.packageName.endsWith(`/${pkg}`))
      console.log(`Uninstalling ${pkg}...`)
      execSync(`npm uninstall ${pkg}`, { stdio: "inherit", cwd: process.cwd() })
      await writePluginOperation({ type: "uninstall", packageName: loaded?.packageName ?? pkg, at: new Date().toISOString() })
      console.log(`Plugin uninstalled: ${pkg}`)
      console.log("Gateway hot-reload signal emitted.")
    } catch (err: any) {
      console.error(`Failed to uninstall: ${err.message}`)
      process.exit(1)
    }
  })

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  program.parse()
}

// ─── CLI Helpers ────────────────────────────────────────────────

function parseTentaclesMd(content: string): { id: string; status: string; health?: string; lastReport?: string }[] {
  const results: { id: string; status: string; health?: string; lastReport?: string }[] = []
  const sectionRegex = /^###\s+(\S+)/gm
  let match
  while ((match = sectionRegex.exec(content)) !== null) {
    const id = match[1]
    const startIdx = match.index + match[0].length
    const nextSection = content.indexOf("\n### ", startIdx)
    const block = nextSection === -1 ? content.slice(startIdx) : content.slice(startIdx, nextSection)

    let status = "unknown"
    let health: string | undefined
    let lastReport: string | undefined

    const statusMatch = block.match(/(?:status:|- \*\*状态：\*\*)\s*(\S+)/)
    if (statusMatch) status = statusMatch[1]

    const healthMatch = block.match(/(?:health:|- \*\*健康度：\*\*)\s*(\S+)/)
    if (healthMatch) health = healthMatch[1]

    const reportMatch = block.match(/(?:lastReport:|- \*\*最后上报：\*\*)\s*(.+)/)
    if (reportMatch) lastReport = reportMatch[1].trim()

    results.push({ id, status, health, lastReport })
  }
  return results
}

async function readTodayCost(logDir: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  return readCostForDate(logDir, today)
}

async function readCostForDate(logDir: string, date: string): Promise<number> {
  const logFile = path.join(logDir, `cost-${date}.log`)
  if (!existsSync(logFile)) return 0
  try {
    const content = await fs.readFile(logFile, "utf-8")
    let total = 0
    for (const line of content.trim().split("\n")) {
      try {
        const obj = JSON.parse(line)
        if (obj.cost_usd) total += obj.cost_usd
        else if (obj.estimated_cost_usd) total += obj.estimated_cost_usd
      } catch { /* skip bad lines */ }
    }
    return total
  } catch {
    return 0
  }
}

async function readCostRange(logDir: string, days: number): Promise<number> {
  let total = 0
  const now = new Date()
  for (let i = 0; i < days; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const date = d.toISOString().slice(0, 10)
    total += await readCostForDate(logDir, date)
  }
  return total
}

async function readCostBreakdown(logDir: string, days: number): Promise<Record<string, number>> {
  const breakdown: Record<string, number> = {}
  const now = new Date()
  for (let i = 0; i < days; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const date = d.toISOString().slice(0, 10)
    const logFile = path.join(logDir, `cost-${date}.log`)
    if (!existsSync(logFile)) continue
    try {
      const content = readFileSync(logFile, "utf-8")
      for (const line of content.trim().split("\n")) {
        try {
          const obj = JSON.parse(line)
          const cost = obj.cost_usd ?? obj.estimated_cost_usd ?? 0
          const type = obj.type ?? obj.event ?? "unknown"
          breakdown[type] = (breakdown[type] ?? 0) + cost
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return breakdown
}

function getUptime(): string | null {
  const pidFile = path.join(OPENCEPH_HOME, "state", "brain.pid")
  if (!existsSync(pidFile)) return null
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10)
    if (isNaN(pid)) return null
    // Check if process is running
    process.kill(pid, 0)
    // Read start time
    const startFile = path.join(OPENCEPH_HOME, "state", "brain.start")
    if (existsSync(startFile)) {
      const startTime = new Date(readFileSync(startFile, "utf-8").trim()).getTime()
      const elapsed = Date.now() - startTime
      const hours = Math.floor(elapsed / (1000 * 60 * 60))
      const days = Math.floor(hours / 24)
      const mins = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60))
      if (days > 0) return `${days}d ${hours % 24}h ${mins}m`
      if (hours > 0) return `${hours}h ${mins}m`
      return `${mins}m`
    }
    return "running"
  } catch {
    return null
  }
}

type DoctorIssue = {
  check: string
  status: "ok" | "warn" | "error"
  message: string
  fixable?: boolean
}

async function readStatusSnapshot(config: ReturnType<typeof loadConfig>) {
  const runtimeStatus = await readRuntimeStatus()
  const workspaceDir = config.agents?.defaults?.workspace ?? path.join(OPENCEPH_HOME, "workspace")
  const tentaclesPath = path.join(workspaceDir, "TENTACLES.md")
  const tentacles = runtimeStatus.tentacles?.length
    ? runtimeStatus.tentacles.map((item) => ({
        id: item.tentacleId,
        status: item.status,
        health: item.healthScore !== undefined ? item.healthScore.toFixed(2) : undefined,
        lastReport: item.lastReportAt,
      }))
    : existsSync(tentaclesPath)
    ? parseTentaclesMd(readFileSync(tentaclesPath, "utf-8"))
    : []
  const outboundPath = path.join(OPENCEPH_HOME, "state", "outbound-queue.json")
  const pendingPush = existsSync(outboundPath)
    ? (JSON.parse(readFileSync(outboundPath, "utf-8")) as Array<{ status?: string }>).filter((item) => item.status === "pending").length
    : 0
  const cacheStats = await readCacheStats(config.logging.logDir, 30)
  const sessionStore = new SessionStoreManager("ceph")
  const sessions = await sessionStore.list()
  const mainSession = sessions.find((entry) => entry.sessionKey === `agent:ceph:${config.session.mainKey}`) ?? sessions[0]
  return {
    brain: {
      running: runtimeStatus.brain?.running ?? isPidRunning(readPid("brain.pid")),
      pid: runtimeStatus.brain?.pid ?? readPid("brain.pid"),
      uptime: getUptime(),
    },
    gateway: {
      running: runtimeStatus.gateway?.running ?? isPidRunning(readPid("gateway.pid")),
      pid: runtimeStatus.gateway?.pid ?? readPid("gateway.pid"),
      port: runtimeStatus.gateway?.port ?? config.gateway.port,
    },
    model: runtimeStatus.brain?.model ?? config.agents.defaults.model.primary,
    session: {
      sessionKey: mainSession?.sessionKey ?? `agent:ceph:${config.session.mainKey}`,
      totalTokens: mainSession?.inputTokens ?? 0,
      outputTokens: mainSession?.outputTokens ?? 0,
    },
    channels: [
      config.channels.telegram?.enabled ? "telegram ✅" : null,
      config.channels.feishu?.enabled ? "feishu ✅" : null,
      config.channels.webchat?.enabled ? "webchat ✅" : null,
    ].filter(Boolean) as string[],
    tentacles: {
      items: tentacles,
      running: tentacles.filter((t) => t.status === "running").length,
      weakened: tentacles.filter((t) => t.status === "weakened").length,
      crashed: tentacles.filter((t) => t.status === "crashed").length,
    },
    pendingPush,
    todayCost: await readTodayCost(config.logging.logDir),
    cacheStats,
  }
}

async function readCacheStats(logDir: string, days: number): Promise<{ hitRate: number; estimatedSavingsUsd: number }> {
  const traceFile = path.join(logDir, "cache-trace.jsonl")
  if (!existsSync(traceFile)) return { hitRate: 0, estimatedSavingsUsd: 0 }

  const content = await fs.readFile(traceFile, "utf-8")
  let cacheRead = 0
  let input = 0
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      const ts = obj.ts ? new Date(obj.ts).getTime() : Date.now()
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
      if (ts < cutoff) continue
      cacheRead += Number(obj.cache_read_tokens ?? 0)
      input += Number(obj.input_tokens ?? 0)
    } catch {
      // ignore malformed lines
    }
  }
  const hitRate = cacheRead + input > 0 ? Math.round((cacheRead / (cacheRead + input)) * 100) : 0
  const monthlyCost = await readCostRange(logDir, Math.min(days, 30))
  const estimatedSavingsUsd = input > 0 ? monthlyCost * (cacheRead / Math.max(1, input)) : 0
  return { hitRate, estimatedSavingsUsd }
}

async function runDoctorChecks(fix: boolean): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = []
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig()
    issues.push({ check: "Config", status: "ok", message: "valid" })
  } catch (err: any) {
    return [{ check: "Config", status: "error", message: err.message }]
  }

  const workspaceDir = config.agents?.defaults?.workspace ?? path.join(OPENCEPH_HOME, "workspace")
  const stateDir = path.join(OPENCEPH_HOME, "state")

  const credStore = new CredentialStore(CREDENTIALS_DIR)
  const creds = await credStore.list()
  issues.push({
    check: "Credentials",
    status: creds.length > 0 ? "ok" : "warn",
    message: creds.length > 0 ? `${creds.length} credentials` : "no credentials configured",
  })

  const requiredFiles = ["SOUL.md", "AGENTS.md", "IDENTITY.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "MEMORY.md", "TENTACLES.md", "BOOTSTRAP.md"]
  const missingFiles = requiredFiles.filter((file) => !existsSync(path.join(workspaceDir, file)))
  if (missingFiles.length === 0) {
    issues.push({ check: "Workspace", status: "ok", message: `${requiredFiles.length}/${requiredFiles.length} files` })
  } else {
    issues.push({ check: "Workspace", status: "warn", message: `missing: ${missingFiles.join(", ")}`, fixable: true })
    if (fix) {
      const workspaceSrc = path.join(__dirname, "templates", "workspace")
      const workspaceSrcAlt = path.join(__dirname, "..", "src", "templates", "workspace")
      const actualWorkspaceSrc = existsSync(workspaceSrc) ? workspaceSrc : workspaceSrcAlt
      await copyDirIfMissing(actualWorkspaceSrc, workspaceDir)
      issues[issues.length - 1] = { check: "Workspace", status: "ok", message: `${requiredFiles.length}/${requiredFiles.length} files` }
    }
  }

  try {
    await createPiContext(config)
    issues.push({ check: "Pi Framework", status: "ok", message: "context initialized" })
  } catch (err: any) {
    issues.push({ check: "Pi Framework", status: "error", message: err.message })
  }

  try {
    const { McpBridge } = await import("./mcp/mcp-bridge.js")
    const bridge = new McpBridge(config)
    await bridge.init()
    issues.push({ check: "MCP", status: "ok", message: `${Object.keys(config.mcp.servers).length} server(s)` })
    if (fix) await bridge.shutdown()
  } catch (err: any) {
    issues.push({ check: "MCP", status: "warn", message: err.message, fixable: Object.keys(config.mcp.servers).length > 0 })
  }

  const { MemorySearchEngine } = await import("./memory/memory-search.js")
  const searchEngine = new MemorySearchEngine(workspaceDir)
  const memoryDbPath = path.join(workspaceDir, "memory-index", "memory.db")
  try {
    await searchEngine.reindex()
    issues.push({ check: "Memory Index", status: "ok", message: existsSync(memoryDbPath) ? "reindex ok" : "created" })
  } catch (err: any) {
    issues.push({ check: "Memory Index", status: "warn", message: err.message, fixable: true })
    if (fix) {
      await fs.rm(path.join(workspaceDir, "memory-index"), { recursive: true, force: true })
      await searchEngine.reindex()
      issues[issues.length - 1] = { check: "Memory Index", status: "ok", message: "reindexed" }
    }
  }

  const socketPath = config.tentacle.ipcSocketPath
  const brainPid = readPid("brain.pid")
  if (existsSync(socketPath) && !isPidRunning(brainPid)) {
    issues.push({ check: "IPC Socket", status: "warn", message: "stale socket detected", fixable: true })
    if (fix) {
      await fs.unlink(socketPath).catch(() => undefined)
      issues[issues.length - 1] = { check: "IPC Socket", status: "ok", message: "stale socket removed" }
    }
  } else {
    issues.push({ check: "IPC Socket", status: "ok", message: existsSync(socketPath) ? "active" : "no stale socket" })
  }

  const tentaclesPath = path.join(workspaceDir, "TENTACLES.md")
  const tentacles = existsSync(tentaclesPath) ? parseTentaclesMd(readFileSync(tentaclesPath, "utf-8")) : []
  const crashed = tentacles.filter((tentacle) => tentacle.status === "crashed")
  if (crashed.length === 0) {
    issues.push({ check: "Tentacles", status: "ok", message: `${tentacles.filter((t) => t.status !== "killed").length} active` })
  } else {
    issues.push({ check: "Tentacles", status: "warn", message: `${crashed.length} crashed: ${crashed.map((t) => t.id).join(", ")}`, fixable: true })
    if (fix) {
      const next = readFileSync(tentaclesPath, "utf-8").replace(/\*\*状态：\*\* crashed/g, "**状态：** running")
      await fs.writeFile(tentaclesPath, next, "utf-8")
      issues[issues.length - 1] = { check: "Tentacles", status: "ok", message: `recovered ${crashed.length} tentacle record(s)` }
    }
  }

  if (existsSync(config.cron.store)) {
    try {
      JSON.parse(readFileSync(config.cron.store, "utf-8"))
      issues.push({ check: "Cron", status: "ok", message: "store valid" })
    } catch (err: any) {
      issues.push({ check: "Cron", status: "warn", message: "corrupt store", fixable: true })
      if (fix) {
        const services = await createCronServices()
        await services.shutdown()
        issues[issues.length - 1] = { check: "Cron", status: "ok", message: "reloaded" }
      }
    }
  } else {
    issues.push({ check: "Cron", status: "ok", message: "no cron store yet" })
  }

  if (existsSync(config.logging.logDir)) {
    issues.push({ check: "Logs", status: "ok", message: "directory exists" })
  } else {
    issues.push({ check: "Logs", status: "warn", message: "log dir missing", fixable: true })
    if (fix) {
      mkdirSync(config.logging.logDir, { recursive: true })
      issues[issues.length - 1] = { check: "Logs", status: "ok", message: "directory created" }
    }
  }

  void stateDir
  return issues
}

function readPid(fileName: string): number | null {
  const target = path.join(OPENCEPH_HOME, "state", fileName)
  if (!existsSync(target)) return null
  const pid = Number.parseInt(readFileSync(target, "utf-8").trim(), 10)
  return Number.isFinite(pid) ? pid : null
}

function isPidRunning(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPluginState(): { loaded: Array<{ packageName: string; channelId: string; displayName: string; version: string }> } {
  const statePath = path.join(OPENCEPH_HOME, "state", "plugin-state.json")
  if (!existsSync(statePath)) return { loaded: [] }
  try {
    return JSON.parse(readFileSync(statePath, "utf-8"))
  } catch {
    return { loaded: [] }
  }
}

async function writePluginOperation(payload: { type: "install" | "uninstall"; packageName: string; at: string }): Promise<void> {
  const opsPath = path.join(OPENCEPH_HOME, "state", "plugin-ops.json")
  await fs.mkdir(path.dirname(opsPath), { recursive: true })
  await fs.writeFile(opsPath, JSON.stringify(payload, null, 2), "utf-8")
}

export function getBuiltinTentaclesDir(): string {
  return path.join(__dirname, "..", "builtin-tentacles")
}

function getContractsSourceDir(): string {
  // Try dist layout first, then source layout
  const distContracts = path.join(__dirname, "..", "contracts")
  const srcContracts = path.join(__dirname, "..", "..", "contracts")
  if (existsSync(distContracts)) return distContracts
  return srcContracts
}

export async function installContracts(): Promise<void> {
  const sourceDir = getContractsSourceDir()
  if (!(await pathExists(sourceDir))) {
    try { systemLogger.info("contracts_skip", { reason: "source_not_found", path: sourceDir }) } catch {}
    return
  }
  const targetDir = path.join(OPENCEPH_HOME, "contracts")
  await fs.mkdir(targetDir, { recursive: true })
  await fs.cp(sourceDir, targetDir, { recursive: true })
  try { systemLogger.info("contracts_installed", { source: sourceDir, target: targetDir }) } catch {}
}

export async function refreshContracts(): Promise<void> {
  const sourceDir = getContractsSourceDir()
  if (!(await pathExists(sourceDir))) return
  const targetDir = path.join(OPENCEPH_HOME, "contracts")
  await fs.mkdir(targetDir, { recursive: true })
  // Overwrite existing contracts with latest version
  await fs.cp(sourceDir, targetDir, { recursive: true })
  try { systemLogger.info("contracts_refreshed", { source: sourceDir, target: targetDir }) } catch {}
}

async function readSkillVersion(skillDir: string): Promise<string> {
  try {
    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")
    return content.match(/\nversion:\s*([^\n]+)/)?.[1]?.trim() ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function copyDirOverwrite(sourceDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true })
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirOverwrite(sourcePath, destPath)
    } else {
      await fs.copyFile(sourcePath, destPath)
    }
  }
}

export async function initBuiltinTentacles(targetSkillsDir: string, skipList: string[] = []): Promise<void> {
  const builtinDir = getBuiltinTentaclesDir()
  if (!(await pathExists(builtinDir))) return

  const entries = await fs.readdir(builtinDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || skipList.includes(entry.name)) continue
    const sourcePath = path.join(builtinDir, entry.name)
    const targetPath = path.join(targetSkillsDir, entry.name)

    if (await pathExists(targetPath)) {
      try {
        systemLogger.info("builtin_tentacle_skip", { name: entry.name, reason: "already_exists" })
      } catch {}
      continue
    }

    await fs.cp(sourcePath, targetPath, { recursive: true })
    try {
      systemLogger.info("builtin_tentacle_installed", { name: entry.name })
    } catch {}
  }
}

export async function upgradeBuiltinTentacles(targetSkillsDir: string, skipList: string[] = []): Promise<void> {
  const builtinDir = getBuiltinTentaclesDir()
  if (!(await pathExists(builtinDir))) return

  const entries = await fs.readdir(builtinDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || skipList.includes(entry.name)) continue

    const sourcePath = path.join(builtinDir, entry.name)
    const targetPath = path.join(targetSkillsDir, entry.name)

    if (!(await pathExists(targetPath))) {
      await fs.cp(sourcePath, targetPath, { recursive: true })
      try {
        systemLogger.info("builtin_tentacle_installed", { name: entry.name, reason: "missing_target" })
      } catch {}
      continue
    }

    const builtinVersion = await readSkillVersion(sourcePath)
    const installedVersion = await readSkillVersion(targetPath)
    if (builtinVersion === installedVersion) continue

    const promptPath = path.join(targetPath, "prompt")
    const backupDir = path.join(targetPath, `.backup-${installedVersion || "unknown"}`)
    if (await pathExists(promptPath)) {
      await fs.mkdir(backupDir, { recursive: true })
      await fs.cp(promptPath, path.join(backupDir, "prompt"), { recursive: true })
    }

    for (const folder of ["src", "docs", "templates"]) {
      const sourceFolder = path.join(sourcePath, folder)
      if (await pathExists(sourceFolder)) {
        await copyDirOverwrite(sourceFolder, path.join(targetPath, folder))
      }
    }

    for (const fileName of ["SKILL.md", "README.md"]) {
      const sourceFile = path.join(sourcePath, fileName)
      if (await pathExists(sourceFile)) {
        await fs.copyFile(sourceFile, path.join(targetPath, fileName))
      }
    }

    try {
      systemLogger.info("builtin_tentacle_upgraded", {
        name: entry.name,
        from: installedVersion,
        to: builtinVersion,
        promptBackup: backupDir,
      })
    } catch {}
  }
}

async function copyDirIfMissing(sourceDir: string, destDir: string): Promise<void> {
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true })
  }
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const destPath = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirIfMissing(sourcePath, destPath)
    } else if (!existsSync(destPath)) {
      copyFileSync(sourcePath, destPath)
    }
  }
}

function buildScheduleFromOptions(opts: any) {
  if (opts.cron) {
    return { kind: "cron" as const, expr: opts.cron, tz: opts.tz }
  }
  if (opts.every) {
    return { kind: "every" as const, everyMs: parseDurationMs(opts.every) }
  }
  if (opts.at) {
    return { kind: "at" as const, at: opts.at }
  }
  throw new Error("Specify one of --cron, --every, or --at")
}
