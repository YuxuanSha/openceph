import { spawn, type ChildProcess } from "child_process"
import type { OpenCephConfig } from "../config/config-schema.js"
import type { ToolRegistryEntry } from "../tools/index.js"
import { mcpToolToRegistryEntry } from "./tool-registry.js"
import { SearchCache } from "./search-cache.js"
import { systemLogger } from "../logger/index.js"

interface McpServerProcess {
  name: string
  process: ChildProcess | null
  tools: Array<{ name: string; description?: string; inputSchema?: any }>
  ready: boolean
  config: OpenCephConfig["mcp"]["servers"][string]
  reconnectAttempts: number
  shuttingDown: boolean
}

/**
 * MCP Bridge: manages MCP server processes and exposes their tools.
 * Currently supports stdio transport for command-type servers.
 */
export class McpBridge {
  private servers: Map<string, McpServerProcess> = new Map()
  private searchCache: SearchCache
  private config: OpenCephConfig

  constructor(config: OpenCephConfig) {
    this.config = config
    this.searchCache = new SearchCache(config.mcp.webSearch.cacheTtlMinutes)
  }

  async init(): Promise<void> {
    const serverConfigs = this.config.mcp.servers

    for (const [name, serverCfg] of Object.entries(serverConfigs)) {
      try {
        if (serverCfg.command) {
          const server: McpServerProcess = {
            name,
            process: null,
            tools: [],
            ready: false,
            config: serverCfg,
            reconnectAttempts: 0,
            shuttingDown: false,
          }
          this.servers.set(name, server)
          await this.startCommandServer(server)
        } else if (serverCfg.type === "sse") {
          // SSE transport — not yet implemented
          systemLogger.info("mcp_sse_skipped", { server: name, url: serverCfg.url })
        }
      } catch (err: any) {
        systemLogger.error("mcp_start_error", { server: name, error: err.message })
      }
    }
  }

  private async startCommandServer(server: McpServerProcess): Promise<void> {
    const serverCfg = server.config
    const proc = spawn(serverCfg.command!, serverCfg.args ?? [], {
      env: { ...process.env, ...serverCfg.env },
      stdio: ["pipe", "pipe", "pipe"],
    })

    server.process = proc
    server.ready = false

    proc.stderr?.on("data", (data) => {
      systemLogger.warn("mcp_stderr", { server: server.name, data: data.toString().slice(0, 500) })
    })

    proc.on("error", (err) => {
      systemLogger.error("mcp_process_error", { server: server.name, error: err.message })
      void this.scheduleReconnect(server, "error")
    })

    proc.on("exit", (code) => {
      server.process = null
      server.ready = false
      systemLogger.info("mcp_process_exit", { server: server.name, code })
      void this.scheduleReconnect(server, "exit")
    })

    try {
      await this.initializeServer(server)
      server.reconnectAttempts = 0
    } catch (err: any) {
      systemLogger.warn("mcp_init_failed", { server: server.name, error: err.message })
      await this.scheduleReconnect(server, "init_failed")
    }

    systemLogger.info("mcp_connected", {
      server: server.name,
      tools: server.tools.length,
    })
  }

  private async scheduleReconnect(server: McpServerProcess, reason: string): Promise<void> {
    if (server.shuttingDown) return
    if (server.reconnectAttempts >= 5) {
      systemLogger.error("mcp_disconnect_permanent", { server: server.name, reason })
      return
    }

    server.reconnectAttempts += 1
    const delayMs = 2 ** (server.reconnectAttempts - 1) * 1000
    systemLogger.warn("mcp_reconnect", {
      server: server.name,
      reason,
      attempt: server.reconnectAttempts,
      delay_ms: delayMs,
    })
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (server.shuttingDown) return
    await this.startCommandServer(server)
  }

  private async initializeServer(server: McpServerProcess): Promise<void> {
    // Send JSON-RPC initialize request
    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "openceph", version: "0.1.0" },
      },
    })

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("MCP initialize timeout"))
      }, 10000)

      let buffer = ""
      const onData = (data: Buffer) => {
        buffer += data.toString()
        try {
          const response = JSON.parse(buffer)
          if (response.result) {
            server.ready = true
            clearTimeout(timeout)
            server.process?.stdout?.off("data", onData)

            // Now request tool list
            this.listTools(server).then(() => resolve()).catch(resolve as any)
          }
        } catch {
          // Incomplete JSON, keep buffering
        }
      }

      server.process?.stdout?.on("data", onData)
      server.process?.stdin?.write(initRequest + "\n")
    })
  }

  private async listTools(server: McpServerProcess): Promise<void> {
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000)
      let buffer = ""

      const onData = (data: Buffer) => {
        buffer += data.toString()
        try {
          const response = JSON.parse(buffer)
          if (response.result?.tools) {
            server.tools = response.result.tools
            clearTimeout(timeout)
            server.process?.stdout?.off("data", onData)
          }
          resolve()
        } catch {
          // Keep buffering
        }
      }

      server.process?.stdout?.on("data", onData)
      server.process?.stdin?.write(request + "\n")
    })
  }

  /** Get all MCP tools as ToolRegistryEntries */
  getTools(): ToolRegistryEntry[] {
    const entries: ToolRegistryEntry[] = []
    for (const [name, server] of this.servers) {
      for (const tool of server.tools) {
        entries.push(mcpToolToRegistryEntry(name, tool, this))
      }
    }
    return entries
  }

  /** Execute an MCP tool call */
  async call(serverName: string, toolName: string, input: unknown): Promise<unknown> {
    // Check search cache for web_search/web_fetch
    if (toolName === "search" || toolName === "web_search") {
      const queryKey = JSON.stringify(input)
      const cached = this.searchCache.get(queryKey)
      if (cached) return cached
    }

    const server = this.servers.get(serverName)
    if (!server?.process || !server.ready) {
      throw new Error(`MCP server not available: ${serverName}`)
    }

    const id = Date.now()
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: input },
    })

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MCP call timeout")), 30000)
      let buffer = ""

      const onData = (data: Buffer) => {
        buffer += data.toString()
        try {
          const response = JSON.parse(buffer)
          if (response.id === id) {
            clearTimeout(timeout)
            server.process?.stdout?.off("data", onData)

            if (response.error) {
              reject(new Error(response.error.message))
            } else {
              const result = response.result
              // Cache search results
              if (toolName === "search" || toolName === "web_search") {
                this.searchCache.set(JSON.stringify(input), result)
              }
              resolve(result)
            }
          }
        } catch {
          // Keep buffering
        }
      }

      server.process?.stdout?.on("data", onData)
      server.process?.stdin?.write(request + "\n")
    })
  }

  async shutdown(): Promise<void> {
    for (const [name, server] of this.servers) {
      try {
        server.shuttingDown = true
        server.process?.kill("SIGTERM")
        systemLogger.info("mcp_shutdown", { server: name })
      } catch { /* ignore */ }
    }
    this.servers.clear()
  }
}
