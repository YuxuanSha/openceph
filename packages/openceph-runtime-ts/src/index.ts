/**
 * @openceph/runtime — TypeScript runtime SDK for OpenCeph skill_tentacles.
 *
 * Mirrors the Python openceph-runtime API surface:
 *   IpcClient, LlmClient, AgentLoop, TentacleLogger, TentacleConfig, StateDB, loadTools
 */

import * as fs from "fs"
import * as path from "path"
import * as readline from "readline"
import * as crypto from "crypto"

// ━━━ TentacleConfig ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class TentacleConfig {
  tentacleId: string
  tentacleDir: string
  workspace: string
  runtimeDir: string
  socketPath: string
  llmGatewayUrl: string
  llmGatewayToken: string
  triggerMode: string
  selfSchedule: string
  selfIntervalSeconds: number
  pollInterval: number
  batchThreshold: number
  purpose: string
  capabilities: Record<string, unknown>
  private _data: Record<string, unknown>

  constructor() {
    this.tentacleDir = process.env.OPENCEPH_TENTACLE_DIR || "."
    // Load tentacle.json
    this._data = {}
    const jsonPath = path.join(this.tentacleDir, "tentacle.json")
    if (fs.existsSync(jsonPath)) {
      try { this._data = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) } catch {}
    }

    this.tentacleId = process.env.OPENCEPH_TENTACLE_ID || "unknown"
    this.workspace = process.env.OPENCEPH_TENTACLE_WORKSPACE || "./workspace"
    this.runtimeDir = process.env.OPENCEPH_RUNTIME_DIR || "."
    this.socketPath = process.env.OPENCEPH_SOCKET_PATH || ""
    this.llmGatewayUrl = process.env.OPENCEPH_LLM_GATEWAY_URL || "http://127.0.0.1:18792"
    this.llmGatewayToken = process.env.OPENCEPH_LLM_GATEWAY_TOKEN || ""
    this.triggerMode = process.env.OPENCEPH_TRIGGER_MODE || "self"
    this.selfSchedule = process.env.OPENCEPH_SELF_SCHEDULE || ""
    this.selfIntervalSeconds = parseInt(process.env.OPENCEPH_SELF_INTERVAL_SECONDS || "3600", 10)

    this.purpose = process.env.OPENCEPH_PURPOSE || (this._data as any).purpose || ""
    this.pollInterval = parseInt(
      process.env.OPENCEPH_POLL_INTERVAL || String((this._data as any).pollInterval || this.selfIntervalSeconds),
      10,
    )
    this.batchThreshold = parseInt(
      process.env.OPENCEPH_BATCH_THRESHOLD ||
        String(((this._data as any).capabilities?.consultation?.batchThreshold) || 5),
      10,
    )
    this.capabilities = (this._data as any).capabilities || {}
  }

  get(key: string, defaultValue?: string): string {
    const envKey = "OPENCEPH_" + key.toUpperCase().replace(/\./g, "_")
    if (process.env[envKey] !== undefined) return process.env[envKey]!
    const parts = key.split(".")
    let current: unknown = this._data
    for (const part of parts) {
      if (current && typeof current === "object") current = (current as any)[part]
      else return defaultValue ?? ""
    }
    return current !== undefined && current !== null ? String(current) : (defaultValue ?? "")
  }
}

// ━━━ StateDB ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class StateDB {
  private _processed = new Set<string>()
  private _stats = new Map<string, number>()
  private _state = new Map<string, string>()

  isProcessed(itemId: string): boolean {
    return this._processed.has(itemId)
  }

  markProcessed(itemId: string): void {
    this._processed.add(itemId)
  }

  incrementStat(key: string, amount: number = 1): number {
    const val = (this._stats.get(key) || 0) + amount
    this._stats.set(key, val)
    return val
  }

  getStat(key: string): number {
    return this._stats.get(key) || 0
  }

  setState(key: string, value: string): void {
    this._state.set(key, value)
  }

  getState(key: string, defaultValue?: string): string | undefined {
    return this._state.get(key) ?? defaultValue
  }

  close(): void {}
}

// ━━━ TentacleLogger ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class TentacleLogger {
  daemon(event: string, data?: Record<string, unknown>): void {
    console.error(JSON.stringify({ layer: "daemon", event, ...data, ts: new Date().toISOString() }))
  }

  agent(event: string, data?: Record<string, unknown>): void {
    console.error(JSON.stringify({ layer: "agent", event, ...data, ts: new Date().toISOString() }))
  }

  consultation(event: string, data?: Record<string, unknown>): void {
    console.error(JSON.stringify({ layer: "consultation", event, ...data, ts: new Date().toISOString() }))
  }
}

// ━━━ IpcClient ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface IpcMessage {
  type: string
  tentacle_id: string
  message_id: string
  timestamp: string
  payload: Record<string, unknown>
}

type DirectiveHandler = (action: string, params: Record<string, unknown>) => void
type ConsultationReplyHandler = (
  consultationId: string, message: string,
  actionsTaken: Array<{ action: string; item_ref: string; push_id?: string }>,
  shouldContinue: boolean,
) => void
type ConsultationCloseHandler = (
  consultationId: string, summary: string,
  pushedCount: number, discardedCount: number, feedback?: string,
) => void

export class IpcClient {
  private _tentacleId = process.env.OPENCEPH_TENTACLE_ID || "unknown"
  private _rl?: readline.Interface
  private _directiveHandlers: DirectiveHandler[] = []
  private _replyHandlers: ConsultationReplyHandler[] = []
  private _closeHandlers: ConsultationCloseHandler[] = []
  private _pendingTools = new Map<string, { resolve: (v: any) => void }>()

  connect(): void {
    this._rl = readline.createInterface({ input: process.stdin })
    this._rl.on("line", (line) => this._handleLine(line))
  }

  close(): void {
    this._rl?.close()
  }

  private _send(msg: IpcMessage): void {
    process.stdout.write(JSON.stringify(msg) + "\n")
  }

  private _makeMsg(type: string, payload: Record<string, unknown>): IpcMessage {
    return {
      type,
      tentacle_id: this._tentacleId,
      message_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload,
    }
  }

  register(opts: {
    purpose?: string; runtime?: string;
    capabilities?: Record<string, unknown>; tools?: string[]; version?: string
  } = {}): void {
    this._send(this._makeMsg("tentacle_register", {
      purpose: opts.purpose || "",
      runtime: opts.runtime || "typescript",
      pid: process.pid,
      capabilities: opts.capabilities || { daemon: [], agent: [], consultation: { mode: "batch" } },
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.version ? { version: opts.version } : {}),
    }))
  }

  statusUpdate(opts: { status?: string; pendingItems?: number; health?: string }): void {
    this._send(this._makeMsg("status_update", {
      status: opts.status || "idle",
      pending_items: opts.pendingItems || 0,
      health: opts.health || "ok",
      last_daemon_run: new Date().toISOString(),
    }))
  }

  consultationRequest(opts: {
    mode?: string; summary: string; initialMessage: string;
    itemCount?: number; urgency?: string; context?: Record<string, unknown>
  }): void {
    this._send(this._makeMsg("consultation_request", {
      mode: opts.mode || "batch",
      summary: opts.summary,
      initial_message: opts.initialMessage,
      item_count: opts.itemCount || 0,
      urgency: opts.urgency || "normal",
      context: opts.context || {},
    }))
  }

  consultationMessage(consultationId: string, message: string): void {
    this._send(this._makeMsg("consultation_message", { consultation_id: consultationId, message }))
  }

  consultationEnd(consultationId: string, reason: string = "complete"): void {
    this._send(this._makeMsg("consultation_end", { consultation_id: consultationId, reason }))
  }

  heartbeatAck(): void {
    this._send(this._makeMsg("heartbeat_ack", {}))
  }

  async toolRequest(toolName: string, toolCallId: string, args: Record<string, unknown>, timeout = 30000): Promise<{ result: unknown; success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingTools.delete(toolCallId)
        resolve({ result: {}, success: false, error: `tool_request timed out after ${timeout}ms` })
      }, timeout)
      this._pendingTools.set(toolCallId, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
      })
      this._send(this._makeMsg("tool_request", { tool_name: toolName, tool_call_id: toolCallId, arguments: args }))
    })
  }

  onDirective(handler: DirectiveHandler): void { this._directiveHandlers.push(handler) }
  onConsultationReply(handler: ConsultationReplyHandler): void { this._replyHandlers.push(handler) }
  onConsultationClose(handler: ConsultationCloseHandler): void { this._closeHandlers.push(handler) }

  private _handleLine(line: string): void {
    try {
      const msg: IpcMessage = JSON.parse(line.trim())
      const p = msg.payload
      if (msg.type === "directive") {
        for (const h of this._directiveHandlers) h(p.action as string, (p.params || {}) as Record<string, unknown>)
      } else if (msg.type === "consultation_reply") {
        for (const h of this._replyHandlers) h(
          p.consultation_id as string, p.message as string,
          (p.actions_taken || []) as any, !!p.continue,
        )
      } else if (msg.type === "consultation_close") {
        for (const h of this._closeHandlers) h(
          p.consultation_id as string, p.summary as string,
          (p.pushed_count || 0) as number, (p.discarded_count || 0) as number,
          p.feedback as string | undefined,
        )
      } else if (msg.type === "heartbeat_ping") {
        this.heartbeatAck()
      } else if (msg.type === "tool_result") {
        const tcid = p.tool_call_id as string
        const pending = this._pendingTools.get(tcid)
        if (pending) {
          this._pendingTools.delete(tcid)
          pending.resolve({ result: p.result, success: !!p.success, error: p.error as string | undefined })
        }
      }
    } catch {}
  }
}

// ━━━ LlmClient ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface LlmResponse {
  content: string
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
  finishReason: string
}

export class LlmClient {
  private baseUrl: string
  private token: string
  private defaultModel: string

  constructor() {
    this.baseUrl = process.env.OPENCEPH_LLM_GATEWAY_URL || "http://127.0.0.1:18792"
    // Normalize: strip trailing /v1 so we can always append /v1/chat/completions
    this.baseUrl = this.baseUrl.replace(/\/+$/, "")
    if (this.baseUrl.endsWith("/v1")) {
      this.baseUrl = this.baseUrl.slice(0, -3)
    }
    this.token = process.env.OPENCEPH_LLM_GATEWAY_TOKEN || ""
    this.defaultModel = process.env.OPENCEPH_LLM_MODEL || "default"
  }

  async chat(
    messages: Array<{ role: string; content: string }>,
    opts?: { model?: string; tools?: unknown[]; temperature?: number },
  ): Promise<LlmResponse> {
    const resolvedModel = (opts?.model && opts.model !== "default") ? opts.model : this.defaultModel
    const body: Record<string, unknown> = {
      model: resolvedModel,
      messages,
      temperature: opts?.temperature ?? 0.3,
    }
    if (opts?.tools) body.tools = opts.tools

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(body),
    })

    if (!resp.ok) throw new Error(`LLM Gateway error: ${resp.status} ${await resp.text()}`)
    const data = await resp.json() as any
    const choice = data.choices?.[0]
    return {
      content: choice?.message?.content || "",
      toolCalls: choice?.message?.tool_calls,
      finishReason: choice?.finish_reason || "stop",
    }
  }
}

// ━━━ AgentLoop ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface AgentResult {
  content: string
  messages: Array<Record<string, unknown>>
  turns: number
  finishReason: string
}

export class AgentLoop {
  private systemPrompt: string
  private tools?: unknown[]
  private maxTurns: number
  private ipc?: IpcClient
  private llm: LlmClient
  private temperature: number
  private model: string

  constructor(opts: {
    systemPrompt: string; tools?: unknown[]; maxTurns?: number;
    ipc?: IpcClient; llm?: LlmClient; temperature?: number; model?: string
  }) {
    this.systemPrompt = opts.systemPrompt
    this.tools = opts.tools
    this.maxTurns = opts.maxTurns || 20
    this.ipc = opts.ipc
    this.llm = opts.llm || new LlmClient()
    this.temperature = opts.temperature ?? 0.3
    this.model = opts.model || "default"
  }

  async run(
    userMessage: string,
    toolExecutor?: (toolName: string, args: Record<string, unknown>) => string,
  ): Promise<AgentResult> {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userMessage },
    ]

    let turns = 0
    while (turns < this.maxTurns) {
      turns++
      const response = await this.llm.chat(
        messages as any,
        { model: this.model, tools: this.tools, temperature: this.temperature },
      )

      const assistantMsg: Record<string, unknown> = { role: "assistant" }
      if (response.content) assistantMsg.content = response.content
      if (response.toolCalls) assistantMsg.tool_calls = response.toolCalls
      messages.push(assistantMsg)

      if (!response.toolCalls?.length) {
        return { content: response.content, messages, turns, finishReason: response.finishReason }
      }

      for (const tc of response.toolCalls) {
        const toolName = tc.function.name
        const toolCallId = tc.id
        let args: Record<string, unknown>
        try { args = JSON.parse(tc.function.arguments) } catch { args = {} }

        let result: string
        if (toolName.startsWith("openceph_") && this.ipc) {
          const ipcResult = await this.ipc.toolRequest(toolName, toolCallId, args)
          result = ipcResult.success ? JSON.stringify(ipcResult.result) : `Shared tool error: ${ipcResult.error}`
        } else if (toolExecutor) {
          try { result = toolExecutor(toolName, args) } catch (e: any) { result = `Error: ${e.message}` }
        } else {
          result = `No executor for tool: ${toolName}`
        }

        messages.push({ role: "tool", tool_call_id: toolCallId, content: result })
      }
    }

    return {
      content: (messages[messages.length - 1] as any).content || "",
      messages, turns, finishReason: "max_turns",
    }
  }
}

// ━━━ loadTools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SHARED_TOOLS = [
  {
    type: "function",
    function: {
      name: "openceph_web_search",
      description: "Search the web via Brain's shared web_search tool.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query keywords" },
          max_results: { type: "integer", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "openceph_web_fetch",
      description: "Fetch a URL's content via Brain's shared web_fetch tool.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          max_length: { type: "integer", description: "Max chars (default 5000)" },
        },
        required: ["url"],
      },
    },
  },
]

export function loadTools(toolsPath: string, includeShared: boolean = true): unknown[] {
  let tools: unknown[] = []
  if (fs.existsSync(toolsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(toolsPath, "utf-8"))
      tools = Array.isArray(data) ? data : data.tools || []
    } catch {}
  }
  if (includeShared) {
    const existingNames = new Set(tools.map((t: any) => t?.function?.name))
    for (const st of SHARED_TOOLS) {
      if (!existingNames.has(st.function.name)) tools.push(st)
    }
  }
  return tools
}
