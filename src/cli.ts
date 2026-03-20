#!/usr/bin/env node

import { Command } from "commander"
import * as fs from "fs/promises"
import { existsSync, mkdirSync, readFileSync, copyFileSync } from "fs"
import * as path from "path"
import * as os from "os"
import * as crypto from "crypto"
import * as readline from "readline"
import { loadConfig } from "./config/config-loader.js"
import { CredentialStore } from "./config/credential-store.js"
import { createPiContext } from "./pi/pi-context.js"
import { initLoggers } from "./logger/index.js"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const OPENCEPH_HOME = path.join(os.homedir(), ".openceph")
const CREDENTIALS_DIR = path.join(OPENCEPH_HOME, "credentials")

const program = new Command()

program
  .name("openceph")
  .description("OpenCeph — AI Personal Operating System")
  .version("0.1.0")

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
      const { newCommand, stopCommand } = await import("./gateway/commands/session.js")
      const { statusCommand, whoamiCommand } = await import("./gateway/commands/status.js")
      const { helpCommand } = await import("./gateway/commands/help.js")
      const { modelCommand } = await import("./gateway/commands/model.js")
      const { tentaclesCommand } = await import("./gateway/commands/tentacle.js")

      const cmdHandler = new CommandHandler()
      cmdHandler.register("/new", newCommand)
      cmdHandler.register("/reset", newCommand)
      cmdHandler.register("/stop", stopCommand)
      cmdHandler.register("/status", statusCommand)
      cmdHandler.register("/whoami", whoamiCommand)
      cmdHandler.register("/help", helpCommand)
      cmdHandler.register("/model", modelCommand)
      cmdHandler.register("/tentacles", tentaclesCommand)

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

program.parse()

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
