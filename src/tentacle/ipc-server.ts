import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as net from "net"
import { systemLogger } from "../logger/index.js"
import type { IpcMessage } from "./contract.js"

export class IpcServer {
  private server: net.Server | null = null
  private connections: Map<string, net.Socket> = new Map()
  private socketToTentacle: Map<net.Socket, string> = new Map()
  private messageHandler: ((tentacleId: string, message: IpcMessage) => Promise<void>) | null = null

  constructor(private socketPath: string) {}

  async start(): Promise<void> {
    if (this.server) return
    if (existsSync(this.socketPath)) {
      await fs.unlink(this.socketPath)
    }

    this.server = net.createServer((socket) => {
      let buffer = ""

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8")
        const parts = buffer.split("\n")
        buffer = parts.pop() ?? ""

        for (const part of parts) {
          const line = part.trim()
          if (!line) continue
          try {
            const message = JSON.parse(line) as IpcMessage
            if (message.type === "tentacle_register") {
              this.connections.set(message.sender, socket)
              this.socketToTentacle.set(socket, message.sender)
            }
            void this.messageHandler?.(message.sender, message)
          } catch {
            // ignore malformed messages and keep the socket open
          }
        }
      })

      socket.on("close", () => {
        const tentacleId = this.socketToTentacle.get(socket)
        if (tentacleId) {
          this.connections.delete(tentacleId)
          this.socketToTentacle.delete(socket)
        }
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject)
      this.server?.listen(this.socketPath, () => resolve())
    })
    systemLogger.info("ipc_server_start", { socket_path: this.socketPath })
  }

  onMessage(handler: (tentacleId: string, message: IpcMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  async sendToTentacle(tentacleId: string, message: IpcMessage): Promise<void> {
    const socket = this.connections.get(tentacleId)
    if (!socket) {
      throw new Error(`Tentacle not connected: ${tentacleId}`)
    }
    await new Promise<void>((resolve, reject) => {
      socket.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  disconnect(tentacleId: string): void {
    const socket = this.connections.get(tentacleId)
    socket?.destroy()
    this.connections.delete(tentacleId)
  }

  getConnectedTentacles(): string[] {
    return Array.from(this.connections.keys()).sort()
  }

  async stop(): Promise<void> {
    for (const socket of this.connections.values()) {
      socket.destroy()
    }
    this.connections.clear()
    this.socketToTentacle.clear()

    if (!this.server) return
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve())
    })
    this.server = null

    if (existsSync(this.socketPath)) {
      await fs.unlink(this.socketPath)
    }
  }
}
