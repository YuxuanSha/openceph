import { setupGlobalProxy } from "./config/proxy-setup.js"
import { loadConfig } from "./config/config-loader.js"
import { initLoggers, systemLogger } from "./logger/index.js"
import { initProcessRuntimeCapture } from "./logger/process-runtime-capture.js"
import { createPiContext } from "./pi/pi-context.js"
import { Brain } from "./brain/brain.js"
import { McpBridge } from "./mcp/mcp-bridge.js"
import { Gateway } from "./gateway/gateway.js"
import { SessionResetScheduler } from "./gateway/session-reset.js"
import { TelegramChannelPlugin } from "./gateway/adapters/telegram/index.js"
import { FeishuChannelPlugin } from "./gateway/adapters/feishu/index.js"
import { WebChatChannelPlugin } from "./gateway/adapters/webchat/index.js"
import { CliChannelPlugin } from "./gateway/adapters/cli/index.js"
import { CronStore } from "./cron/cron-store.js"
import { CronRunner } from "./cron/cron-runner.js"
import { CronScheduler } from "./cron/cron-scheduler.js"
import { HeartbeatRunner } from "./heartbeat/heartbeat-runner.js"
import { HeartbeatScheduler } from "./heartbeat/scheduler.js"
import { MemoryManager } from "./memory/memory-manager.js"
import { SessionStoreManager } from "./session/session-store.js"
import * as fs from "fs/promises"
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs"
import * as path from "path"
import * as os from "os"

const TEMPLATE_VERSION = "1.0.2"

function migrateWorkspaceTemplates(): void {
  const OPENCEPH_HOME = path.join(os.homedir(), ".openceph")
  const workspaceDest = path.join(OPENCEPH_HOME, "workspace")
  if (!existsSync(workspaceDest)) return

  const workspaceSrc = path.join(__dirname, "templates", "workspace")
  const workspaceSrcAlt = path.join(__dirname, "..", "src", "templates", "workspace")
  const actualWorkspaceSrc = existsSync(workspaceSrc) ? workspaceSrc : existsSync(workspaceSrcAlt) ? workspaceSrcAlt : null
  if (!actualWorkspaceSrc) return

  const versionFile = path.join(workspaceDest, ".template-version")
  let currentVersion = ""
  try { currentVersion = readFileSync(versionFile, "utf-8").trim() } catch {}
  if (currentVersion === TEMPLATE_VERSION) return

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

export async function startOpenCeph(): Promise<void> {
  // 0. Set up proxy (must be before any API calls)
  await setupGlobalProxy()

  // 1. Load config
  const config = loadConfig()
  initProcessRuntimeCapture(config.logging.logDir, "ceph")

  // 2. Init loggers
  initLoggers(config)

  // 2.5 Migrate workspace templates for existing installations
  try {
    migrateWorkspaceTemplates()
  } catch (err) {
    systemLogger.warn("template_migration_failed", { error: err instanceof Error ? err.message : String(err) })
  }

  // 3. Create Pi context
  const piCtx = await createPiContext(config)

  // 4. Init MCP Bridge
  const mcpBridge = new McpBridge(config)
  await mcpBridge.init()

  // 5. Create Brain (deliverToUser is wired after Gateway creation via lazy ref)
  let gatewayRef: Gateway | null = null
  const brain = new Brain({
    config,
    piCtx,
    deliverToUser: async (target, content) => {
      if (gatewayRef) {
        await gatewayRef.deliverToUser(target, content)
      } else {
        console.log(`[Ceph → ${target.recipientId ?? target.senderId}] ${content.text}`)
      }
    },
  })
  await brain.initialize()

  // Register MCP tools to brain's tool registry
  const mcpTools = mcpBridge.getTools()
  if (mcpTools.length > 0) {
    await brain.registerTools(mcpTools)
  }

  // 6. Create and start Gateway
  const gateway = new Gateway(config, brain)

  // Register core channel adapters
  if (config.channels.telegram.enabled) {
    gateway.registerChannel(new TelegramChannelPlugin())
  }
  if (config.channels.feishu.enabled) {
    gateway.registerChannel(new FeishuChannelPlugin())
  }
  if (config.channels.webchat.enabled) {
    gateway.registerChannel(new WebChatChannelPlugin())
  }
  gateway.registerChannel(new CliChannelPlugin())

  // Wire deliverToUser now that gateway is created
  gatewayRef = gateway

  await gateway.start()

  // 6.5 Start cron + heartbeat schedulers
  const cronStore = new CronStore(config.cron.store)
  const cronRunner = new CronRunner(
    piCtx,
    config,
    brain,
    gateway,
    cronStore,
    new SessionStoreManager("cron"),
  )
  const cronScheduler = new CronScheduler(config, cronStore, cronRunner)
  await cronScheduler.start()
  await brain.registerCronScheduler(cronScheduler)

  const heartbeatRunner = new HeartbeatRunner(
    piCtx,
    config,
    brain,
    brain.getTentacleManager(),
    new MemoryManager(piCtx.workspaceDir),
    cronScheduler,
  )
  const heartbeatScheduler = new HeartbeatScheduler(config, brain, brain.getTentacleManager(), heartbeatRunner)
  cronRunner.setWakeMainSession(() => heartbeatScheduler.triggerNow())
  brain.registerHeartbeatScheduler(heartbeatScheduler)
  heartbeatScheduler.start()

  // 7. Start session reset scheduler
  const resetScheduler = new SessionResetScheduler(config)
  resetScheduler.start()

  // 8. Log startup
  const stateDir = path.join(os.homedir(), ".openceph", "state")
  await fs.mkdir(stateDir, { recursive: true })
  await fs.writeFile(path.join(stateDir, "brain.pid"), String(process.pid), "utf-8")
  await fs.writeFile(path.join(stateDir, "gateway.pid"), String(process.pid), "utf-8")
  const startedAt = new Date().toISOString()
  await fs.writeFile(path.join(stateDir, "brain.start"), startedAt, "utf-8")
  await fs.writeFile(path.join(stateDir, "gateway.start"), startedAt, "utf-8")

  systemLogger.info("brain_start", {
    model: config.agents.defaults.model.primary,
    channels: [
      config.channels.telegram.enabled && "telegram",
      config.channels.feishu.enabled && "feishu",
      config.channels.webchat.enabled && "webchat",
      "cli",
    ].filter(Boolean),
    mcp_servers: Object.keys(config.mcp.servers),
  })

  // 9. Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...")
    resetScheduler.stop()
    heartbeatScheduler.stop()
    cronScheduler.stop()
    await gateway.stop()
    await mcpBridge.shutdown()
    await brain.shutdown()
    for (const file of ["brain.pid", "gateway.pid"]) {
      const target = path.join(stateDir, file)
      if (existsSync(target)) {
        await fs.unlink(target).catch(() => undefined)
      }
    }
    systemLogger.info("brain_stop", {})
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
