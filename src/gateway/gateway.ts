import type { ChannelPlugin, MessageTarget, OutboundContent } from "./adapters/channel-plugin.js"
import type { Brain } from "../brain/brain.js"
import type { OpenCephConfig } from "../config/config-schema.js"
import { ChannelRouter } from "./router.js"
import { PairingManager } from "./pairing.js"
import { SessionResolver } from "./session-manager.js"
import { MessageQueue } from "./message-queue.js"
import { AuthProfileManager } from "./auth/auth-profiles.js"
import { PluginLoader } from "./plugin-loader.js"
import { gatewayLogger } from "../logger/index.js"
import * as path from "path"
import * as os from "os"

export class Gateway {
  private channelPlugins: Map<string, ChannelPlugin> = new Map()
  private router!: ChannelRouter
  private messageQueue: MessageQueue
  private sessionResolver: SessionResolver
  private pairingManager: PairingManager
  private authProfileManager: AuthProfileManager
  private brain: Brain
  private config: OpenCephConfig

  constructor(config: OpenCephConfig, brain: Brain) {
    this.config = config
    this.brain = brain
    this.messageQueue = new MessageQueue()
    this.sessionResolver = new SessionResolver(config)
    this.pairingManager = new PairingManager(
      path.join(os.homedir(), ".openceph", "state", "pairing.json"),
    )
    this.authProfileManager = new AuthProfileManager(config)
  }

  async start(): Promise<void> {
    // Create router
    this.router = new ChannelRouter(
      this.channelPlugins,
      this.pairingManager,
      this.sessionResolver,
      this.messageQueue,
      this.brain,
      this.config,
    )

    // Register and start core channel adapters
    for (const [channelId, plugin] of this.channelPlugins) {
      const channelCfg = (this.config.channels as any)?.[channelId]
      if (!channelCfg?.enabled && channelId !== "cli") continue

      try {
        await plugin.initialize(
          { enabled: true, dmPolicy: plugin.defaultDmPolicy, allowFrom: [], streaming: true, ...channelCfg },
          {},
        )
        plugin.onMessage((msg) => this.router.route(msg))
        await plugin.start()
        gatewayLogger.info("channel_start", { channel: channelId })
      } catch (err: any) {
        gatewayLogger.error("channel_error", {
          channel: channelId,
          error: err.message,
        })
      }
    }

    // Discover extension plugins (M1: log only)
    try {
      const loader = new PluginLoader(process.cwd())
      await loader.discover()
    } catch { /* non-fatal */ }

    gatewayLogger.info("gateway_start", {
      channels: Array.from(this.channelPlugins.keys()),
    })
  }

  async stop(): Promise<void> {
    for (const [channelId, plugin] of this.channelPlugins) {
      try {
        await plugin.stop()
        gatewayLogger.info("channel_stop", { channel: channelId })
      } catch (err: any) {
        gatewayLogger.error("channel_stop_error", { channel: channelId, error: err.message })
      }
    }
    gatewayLogger.info("gateway_stop", {})
  }

  registerChannel(plugin: ChannelPlugin): void {
    this.channelPlugins.set(plugin.channelId, plugin)
  }

  async deliverToUser(target: MessageTarget, content: OutboundContent): Promise<void> {
    const channel = this.channelPlugins.get(target.channel)
    if (!channel) {
      gatewayLogger.warn("deliver_no_channel", { channel: target.channel })
      // Fallback: try any available channel
      for (const [, plugin] of this.channelPlugins) {
        try {
          await plugin.send(target, content)
          gatewayLogger.info("message_delivered", { channel: plugin.channelId, fallback: true })
          return
        } catch { /* try next */ }
      }
      // Last resort: log to stdout
      console.log(`[Ceph → ${target.recipientId ?? target.senderId}] ${content.text}`)
      return
    }

    await channel.send(target, content)
    gatewayLogger.info("message_delivered", { channel: target.channel })
  }

  get pairing(): PairingManager {
    return this.pairingManager
  }
}
