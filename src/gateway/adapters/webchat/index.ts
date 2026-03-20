import type {
  ChannelPlugin, ChannelConfig, DmPolicy, MessageTarget,
  OutboundContent, InboundMessage, AuthSystem,
} from "../channel-plugin.js"
import { createWebChatServer } from "./server.js"
import { gatewayLogger } from "../../../logger/index.js"
import type http from "http"
import type { WebSocketServer } from "ws"

export class WebChatChannelPlugin implements ChannelPlugin {
  readonly channelId = "webchat"
  readonly displayName = "WebChat"
  readonly defaultDmPolicy: DmPolicy = "open"

  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private sendToClient: ((senderId: string, data: any) => void) | null = null
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null
  private port: number = 18791
  private authToken?: string

  async initialize(config: ChannelConfig, _auth: AuthSystem): Promise<void> {
    this.port = (config.port as number) ?? 18791
    this.authToken = (config.auth as any)?.token
  }

  async start(): Promise<void> {
    const result = createWebChatServer({
      port: this.port,
      authToken: this.authToken,
      onMessage: async (msg) => {
        await this.messageHandler?.(msg)
      },
    })

    this.server = result.server
    this.wss = result.wss
    this.sendToClient = result.sendToClient

    return new Promise((resolve, reject) => {
      const server = this.server!
      const wss = this.wss
      const cleanup = () => {
        server.off("error", onError)
        server.off("listening", onListening)
        wss?.off("error", onError)
      }
      const onListening = () => {
        cleanup()
        gatewayLogger.info("channel_start", { channel: "webchat", port: this.port })
        resolve()
      }
      const onError = (error: NodeJS.ErrnoException) => {
        cleanup()
        server.close()
        if (error.code === "EADDRINUSE") {
          reject(new Error(`WebChat port ${this.port} is already in use`))
          return
        }
        reject(error)
      }

      server.once("error", onError)
      wss?.once("error", onError)
      server.once("listening", onListening)
      server.listen(this.port, "127.0.0.1")
    })
  }

  async stop(): Promise<void> {
    this.wss?.close()
    this.server?.close()
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  async send(target: MessageTarget, content: OutboundContent): Promise<void> {
    this.sendToClient?.(target.senderId, {
      type: "message_complete",
      text: content.text,
    })
  }

  validateSender(_senderId: string, policy: DmPolicy, _allowFrom: string[]): boolean {
    return policy !== "disabled"
  }
}
