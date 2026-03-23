import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as net from "net"
import type { Readable, Writable } from "stream"
import { systemLogger } from "../logger/index.js"
import type { IpcMessage } from "./contract.js"

interface RegisteredChannel {
  transport: "socket" | "stdio"
  write: (line: string) => Promise<void>
  close: () => void
}

interface StdioAttachment {
  tentacleId: string
  stdin: Writable | null
  stdout: Readable | null
  cleanup: () => void
}

export class IpcServer {
  private server: net.Server | null = null
  private connections: Map<string, RegisteredChannel> = new Map()
  private socketToTentacle: Map<net.Socket, string> = new Map()
  private attachedProcesses: Map<string, StdioAttachment> = new Map()
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
              this.connections.set(message.sender, {
                transport: "socket",
                write: (lineToSend: string) =>
                  new Promise<void>((resolve, reject) => {
                    socket.write(lineToSend, (error) => {
                      if (error) reject(error)
                      else resolve()
                    })
                  }),
                close: () => socket.destroy(),
              })
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

  attachProcess(
    tentacleId: string,
    io: { stdin?: Writable | null; stdout?: Readable | null },
  ): void {
    const stdout = io.stdout ?? null
    const stdin = io.stdin ?? null
    let buffer = ""

    const onStdoutData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        this.handleProcessLine(tentacleId, line, stdin)
      }
    }

    const cleanup = () => {
      if (stdout) {
        stdout.off("data", onStdoutData)
      }
      this.attachedProcesses.delete(tentacleId)
      this.connections.delete(tentacleId)
    }

    if (stdout) {
      stdout.on("data", onStdoutData)
      stdout.once("close", cleanup)
      stdout.once("end", cleanup)
    }

    this.attachedProcesses.set(tentacleId, { tentacleId, stdin, stdout, cleanup })
  }

  async sendToTentacle(tentacleId: string, message: IpcMessage): Promise<void> {
    const channel = this.connections.get(tentacleId)
    if (!channel) {
      throw new Error(`Tentacle not connected: ${tentacleId}`)
    }
    await channel.write(`${JSON.stringify(message)}\n`)
  }

  disconnect(tentacleId: string): void {
    this.connections.get(tentacleId)?.close()
    this.connections.delete(tentacleId)
    this.attachedProcesses.get(tentacleId)?.cleanup()
  }

  getConnectedTentacles(): string[] {
    return Array.from(this.connections.keys()).sort()
  }

  async stop(): Promise<void> {
    for (const socket of this.connections.values()) {
      socket.close()
    }
    this.connections.clear()
    this.socketToTentacle.clear()
    for (const attached of this.attachedProcesses.values()) {
      attached.cleanup()
    }
    this.attachedProcesses.clear()

    if (!this.server) return
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve())
    })
    this.server = null

    if (existsSync(this.socketPath)) {
      await fs.unlink(this.socketPath)
    }
  }

  private handleProcessLine(tentacleId: string, line: string, stdin: Writable | null): void {
    let message: IpcMessage
    try {
      message = JSON.parse(line) as IpcMessage
    } catch {
      return
    }

    const sender = typeof message.sender === "string" && message.sender.trim()
      ? message.sender
      : tentacleId

    if (message.type === "tentacle_register") {
      this.connections.set(sender, {
        transport: "stdio",
        write: (lineToSend: string) => this.writeToProcess(sender, lineToSend),
        close: () => {
          const attached = this.attachedProcesses.get(sender) ?? this.attachedProcesses.get(tentacleId)
          attached?.cleanup()
        },
      })
    }

    void this.messageHandler?.(sender, message)
  }

  private async writeToProcess(tentacleId: string, line: string): Promise<void> {
    const attached = this.attachedProcesses.get(tentacleId)
    const stdin = attached?.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error(`Tentacle stdin unavailable: ${tentacleId}`)
    }

    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}
