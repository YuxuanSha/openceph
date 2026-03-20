import * as readline from "readline"
import type {
  ChannelPlugin, ChannelConfig, DmPolicy, MessageTarget,
  OutboundContent, InboundMessage, AuthSystem,
} from "../channel-plugin.js"

export class CliChannelPlugin implements ChannelPlugin {
  readonly channelId = "cli"
  readonly displayName = "CLI Terminal"
  readonly defaultDmPolicy: DmPolicy = "open"

  private rl: readline.Interface | null = null
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null
  private running = false

  async initialize(_config: ChannelConfig, _auth: AuthSystem): Promise<void> {
    // CLI needs no special initialization
  }

  async start(): Promise<void> {
    this.running = true
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    console.log("🐙 Ceph ready. Type /help for commands.")

    const promptUser = () => {
      if (!this.running) return
      this.rl?.question("> ", async (text) => {
        if (!text?.trim()) {
          promptUser()
          return
        }

        if (text.trim() === "/exit" || text.trim() === "/quit") {
          this.running = false
          this.rl?.close()
          process.exit(0)
        }

        const msg: InboundMessage = {
          channel: "cli",
          senderId: "cli:local",
          sessionKey: "",
          text: text.trim(),
          timestamp: Date.now(),
          rawPayload: {},
        }

        await this.messageHandler?.(msg)
        promptUser()
      })
    }

    promptUser()
  }

  async stop(): Promise<void> {
    this.running = false
    this.rl?.close()
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  async send(_target: MessageTarget, content: OutboundContent): Promise<void> {
    console.log(content.text)
    console.log()
  }

  validateSender(_senderId: string, _policy: DmPolicy, _allowFrom: string[]): boolean {
    return true // CLI is always allowed
  }
}
