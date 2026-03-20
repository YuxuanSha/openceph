import * as crypto from "crypto"
import * as net from "net"
import {
  type DirectivePayload,
  type HeartbeatResultPayload,
  type HeartbeatTriggerPayload,
  type IpcMessage,
  type ReportFindingPayload,
} from "./contract.js"

export class TentacleIpcClient {
  private socket: net.Socket | null = null
  private directiveHandler: ((directive: DirectivePayload) => void) | null = null
  private heartbeatHandler: ((trigger: HeartbeatTriggerPayload) => void) | null = null

  constructor(private socketPath: string, private tentacleId: string) {}

  async connect(): Promise<void> {
    if (this.socket) return

    this.socket = net.createConnection(this.socketPath)
    let buffer = ""
    this.socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8")
      const parts = buffer.split("\n")
      buffer = parts.pop() ?? ""
      for (const part of parts) {
        const line = part.trim()
        if (!line) continue
        try {
          const message = JSON.parse(line) as IpcMessage
          if (message.type === "directive" && this.directiveHandler) {
            this.directiveHandler(message.payload as DirectivePayload)
          }
          if (message.type === "heartbeat_trigger" && this.heartbeatHandler) {
            this.heartbeatHandler(message.payload as HeartbeatTriggerPayload)
          }
        } catch {
          // ignore malformed messages
        }
      }
    })

    await new Promise<void>((resolve) => this.socket?.once("connect", () => resolve()))
  }

  async register(purpose: string, runtime: string): Promise<void> {
    await this.send({
      type: "tentacle_register",
      sender: this.tentacleId,
      receiver: "brain",
      payload: { purpose, runtime },
      timestamp: new Date().toISOString(),
      message_id: crypto.randomUUID(),
    })
  }

  async reportFinding(finding: ReportFindingPayload): Promise<void> {
    await this.send({
      type: "report_finding",
      sender: this.tentacleId,
      receiver: "brain",
      payload: finding,
      timestamp: new Date().toISOString(),
      message_id: crypto.randomUUID(),
    })
  }

  async requestConsultation(_request: unknown): Promise<unknown> {
    throw new Error("Consultation flow is not implemented in Week 2.")
  }

  async sendHeartbeatResult(result: HeartbeatResultPayload): Promise<void> {
    await this.send({
      type: "heartbeat_result",
      sender: this.tentacleId,
      receiver: "brain",
      payload: result,
      timestamp: new Date().toISOString(),
      message_id: crypto.randomUUID(),
    })
  }

  onDirective(handler: (directive: DirectivePayload) => void): void {
    this.directiveHandler = handler
  }

  onHeartbeatTrigger(handler: (trigger: HeartbeatTriggerPayload) => void): void {
    this.heartbeatHandler = handler
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
  }

  private async send(message: IpcMessage): Promise<void> {
    if (!this.socket) {
      throw new Error("IPC client is not connected")
    }

    await new Promise<void>((resolve, reject) => {
      this.socket?.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}
