import { createBrainSession, type BrainSession } from "../pi/pi-session.js"
import type { PiContext } from "../pi/pi-context.js"
import { resolveRunnableModel } from "../pi/model-resolver.js"
import type { OpenCephConfig } from "../config/config-schema.js"
import { SessionStoreManager } from "../session/session-store.js"
import { ToolRegistry } from "../tools/index.js"
import { createMemoryTools } from "../tools/memory-tools.js"
import { createUserTools, executeSendToUser, type GatewayDeliveryFn } from "../tools/user-tools.js"
import { createSkillTools } from "../tools/skill-tools.js"
import { createWebTools } from "../tools/web-tools.js"
import { createSessionTools } from "../tools/session-tools.js"
import { createHeartbeatTools } from "../tools/heartbeat-tools.js"
import { createTentacleTools } from "../tools/tentacle-tools.js"
import { createCodeTools } from "../tools/code-tools.js"
import { createCronTools } from "../tools/cron-tools.js"
import { assembleSystemPrompt, type SystemPromptOptions } from "./system-prompt.js"
import { isNewWorkspace } from "./context-assembler.js"
import { brainLogger, costLogger, gatewayLogger, writeCacheTrace } from "../logger/index.js"
import { updateRuntimeStatus } from "../logger/runtime-status-store.js"
import { IpcServer } from "../tentacle/ipc-server.js"
import { TentacleRegistry } from "../tentacle/registry.js"
import { PendingReportsQueue } from "../tentacle/pending-reports.js"
import { TentacleManager } from "../tentacle/manager.js"
import { LoopDetector } from "./loop-detection.js"
import { SkillLoader } from "../skills/skill-loader.js"
import { SkillSpawner } from "../skills/skill-spawner.js"
import { resolveSkillSearchPaths } from "../skills/search-paths.js"
import { CodeAgent } from "../code-agent/code-agent.js"
import * as os from "os"
import * as fs from "fs/promises"
import * as path from "path"
import * as crypto from "crypto"
import type { CronScheduler } from "../cron/cron-scheduler.js"
import type { HeartbeatScheduler } from "../heartbeat/scheduler.js"
import type { ThinkingLevel } from "@mariozechner/pi-agent-core"
import { OutboundQueue, type ApprovedPushItem, type DeferredMessage } from "../push/outbound-queue.js"
import { PushDecisionEngine, type PushTrigger } from "../push/push-decision.js"
import { PushFeedbackTracker, detectFeedbackSignal } from "../push/feedback-tracker.js"
import { TentacleHealthCalculator } from "../tentacle/health-score.js"
import { TentacleLifecycleManager } from "../tentacle/lifecycle.js"
import { TentacleReviewEngine } from "../tentacle/review-engine.js"
import { ModelFailover, type FailoverDecision } from "./failover.js"
import type { ConsultationReplyPayload, ConsultationRequestPayload } from "../tentacle/contract.js"
import { MemoryManager } from "../memory/memory-manager.js"
import { ConsultationSessionStore, type ConsultationSessionRecord } from "../tentacle/consultation-session-store.js"
import { ConsultationSessionManager } from "../tentacle/consultation-session.js"

export interface BrainOptions {
  config: OpenCephConfig
  piCtx: PiContext
  deliverToUser?: GatewayDeliveryFn
}

export interface BrainInput {
  text: string
  channel: string
  senderId: string
  sessionKey: string
  isDm: boolean
  onTextDelta?: (delta: string) => void
  thinkingLevelOverride?: ThinkingLevel
  reasoningEnabledOverride?: boolean
}

export interface ToolCallRecord {
  name: string
  success: boolean
  durationMs?: number
  args?: Record<string, unknown>
}

export interface BrainOutput {
  text: string
  errorMessage?: string
  toolCalls: ToolCallRecord[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  model: string
  durationMs: number
}

export interface SessionStatusInfo {
  sessionKey: string
  model: string
  inputTokens: number
  outputTokens: number
  activeTentacles: number
  todayCostUsd: number
}

export class Brain {
  private session: BrainSession | null = null
  private toolRegistry: ToolRegistry
  private sessionStore: SessionStoreManager
  private config: OpenCephConfig
  private piCtx: PiContext
  private currentSessionKey: string = ""
  private activeSessionId: string = ""
  private currentModel: string
  private lastActiveChannel: string = "cli"
  private lastActiveSenderId: string = "local"
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private ipcServer: IpcServer
  private tentacleRegistry: TentacleRegistry
  private pendingReports: PendingReportsQueue
  private tentacleManager: TentacleManager
  private skillLoader: SkillLoader
  private skillSpawner: SkillSpawner | null = null
  private cronScheduler: CronScheduler | null = null
  private heartbeatScheduler: HeartbeatScheduler | null = null
  private currentThinkingLevel: ThinkingLevel = "off"
  private reasoningEnabled = false
  private turnsSinceHeartbeat = 0
  private outboundQueue: OutboundQueue
  private pushEngine: PushDecisionEngine
  private feedbackTracker: PushFeedbackTracker
  private healthCalculator: TentacleHealthCalculator
  private lifecycleManager: TentacleLifecycleManager | null = null
  private reviewEngine: TentacleReviewEngine | null = null
  private modelFailover: ModelFailover
  private recentPushContext: Map<string, { messageId: string; itemIds: string[]; tentacleIds: string[]; deliveredAt: string }> = new Map()
  private readonly deliverToUser?: GatewayDeliveryFn
  private readonly memoryManager: MemoryManager
  private readonly consultationStore: ConsultationSessionStore
  private consultationSessionManager: ConsultationSessionManager | null = null
  private readonly pushMessageToConsultationSession: Map<string, string> = new Map()

  constructor(options: BrainOptions) {
    this.config = options.config
    this.piCtx = options.piCtx
    this.deliverToUser = options.deliverToUser
    this.currentModel = options.config.agents.defaults.model.primary
    this.sessionStore = new SessionStoreManager("ceph")
    this.toolRegistry = new ToolRegistry()
    this.ipcServer = new IpcServer(options.config.tentacle.ipcSocketPath)
    this.tentacleRegistry = new TentacleRegistry(options.piCtx.workspaceDir)
    this.pendingReports = new PendingReportsQueue(path.join(os.homedir(), ".openceph", "state", "pending-reports.json"))
    this.tentacleManager = new TentacleManager(
      options.config,
      this.ipcServer,
      this.tentacleRegistry,
      this.pendingReports,
    )
    const skillSearchPaths = resolveSkillSearchPaths(options.config)
    this.skillLoader = new SkillLoader(skillSearchPaths)
    this.modelFailover = new ModelFailover(options.config)
    this.consultationStore = new ConsultationSessionStore(path.join(os.homedir(), ".openceph", "state", "consultations.json"))

    // Initialize push system
    this.outboundQueue = new OutboundQueue(path.join(os.homedir(), ".openceph", "state", "outbound-queue.json"))
    this.healthCalculator = new TentacleHealthCalculator(this.tentacleManager, this.pendingReports)
    this.feedbackTracker = new PushFeedbackTracker(
      path.join(options.piCtx.workspaceDir, "memory"),
      this.healthCalculator,
    )
    this.memoryManager = new MemoryManager(options.piCtx.workspaceDir)
    this.pushEngine = new PushDecisionEngine(options.config, this.outboundQueue, this.memoryManager, this.sessionStore)

    // Register memory tools
    for (const entry of createMemoryTools({
      workspaceDir: options.piCtx.workspaceDir,
      piCtx: options.piCtx,
      config: options.config,
    })) {
      this.toolRegistry.register(entry)
    }

    // Register user tools
    for (const entry of createUserTools({
      config: options.config,
      sessionStore: this.sessionStore,
      deliverToUser: options.deliverToUser,
      lastActiveChannel: () => this.lastActiveChannel,
      lastActiveSenderId: () => this.lastActiveSenderId,
      resolveSessionKey: async (sessionFile) => {
        // Check main (ceph) and cron stores first
        const fromCeph = await this.sessionStore.resolveSessionKeyByTranscriptPath(sessionFile)
        if (fromCeph) return fromCeph
        const fromCron = await new SessionStoreManager("cron").resolveSessionKeyByTranscriptPath(sessionFile)
        if (fromCron) return fromCron
        // Check per-tentacle stores: path like .../agents/tentacles/{id}/sessions/{file}
        const tentacleMatch = sessionFile.match(/agents\/tentacles\/([^/]+)\/sessions\//)
        if (tentacleMatch) {
          const tentacleAgentId = `tentacles/${tentacleMatch[1]}`
          return await new SessionStoreManager(tentacleAgentId).resolveSessionKeyByTranscriptPath(sessionFile)
        }
        return undefined
      },
      onConsultationPush: async (payload) => {
        const syntheticItem: ApprovedPushItem = {
          itemId: payload.pushId,
          tentacleId: payload.tentacleId ?? "unknown",
          content: payload.message,
          originalItems: [],
          priority: payload.priority === "urgent" ? "urgent" : "normal",
          timelinessHint: payload.timing === "immediate" ? "immediate" : "today",
          needsUserAction: false,
          approvedAt: new Date().toISOString(),
          status: payload.delivered ? "sent" : "pending",
          sentAt: payload.delivered ? new Date().toISOString() : undefined,
        }
        if (payload.delivered) {
          this.rememberDeliveredPush(payload.channel, payload.senderId, [syntheticItem], payload.pushId)
        }
        const consultationSessionId = payload.sessionKey.startsWith("consultation:")
          ? payload.sessionKey.slice("consultation:".length)
          : undefined
        if (consultationSessionId) {
          this.pushMessageToConsultationSession.set(payload.pushId, consultationSessionId)
          await this.consultationStore.update(consultationSessionId, {
            recentPushMessageId: payload.pushId,
          })
        }
      },
    })) {
      this.toolRegistry.register(entry)
    }

    for (const entry of createSessionTools("ceph")) {
      this.toolRegistry.register(entry)
    }

    for (const entry of createHeartbeatTools(options.piCtx.workspaceDir)) {
      this.toolRegistry.register(entry)
    }

    for (const entry of createSkillTools(skillSearchPaths)) {
      this.toolRegistry.register(entry)
    }

    // Register built-in web tools (search + fetch, no API key needed)
    for (const entry of createWebTools()) {
      this.toolRegistry.register(entry)
    }
  }

  async initialize(): Promise<void> {
    await this.ipcServer.start()
    await this.tentacleManager.restoreFromRegistry()
    await this.tentacleManager.respawnFromRegistry()
    // Initialize ConsultationSessionManager for multi-turn LLM-based consultations
    this.consultationSessionManager = new ConsultationSessionManager({
      config: this.config,
      tentacleManager: this.tentacleManager,
      consultationStore: this.consultationStore,
      sessionStore: this.sessionStore,
      deliverToUser: this.deliverToUser
        ? async (_channel, _senderId, message) => {
            const pushId = crypto.randomUUID()
            const resolvedChannel = this.lastActiveChannel || "cli"
            const resolvedSender = this.lastActiveSenderId || "local"
            await this.deliverToUser!(
              { channel: resolvedChannel, senderId: resolvedSender, recipientId: resolvedSender },
              { text: message, timing: "immediate", priority: "normal", messageId: pushId },
            )
            return { pushId }
          }
        : undefined,
      getMemorySummary: async () => {
        try {
          return await this.memoryManager.readMemory()
        } catch { return "" }
      },
      getUserPreferences: async () => {
        try {
          const userMdPath = path.join(this.piCtx.workspaceDir, "USER.md")
          return await fs.readFile(userMdPath, "utf-8")
        } catch { return "" }
      },
      runBrainTurn: async (consultationId, systemPrompt, messages, tentacleId) => {
        const output = await this.runIsolatedTurn({
          sessionKey: `consultation:${consultationId}`,
          mode: "minimal",
          message: messages.map(m => {
            const label = m.role === "user" ? `触手:${tentacleId}` : "brain_response"
            return `[${label}]: ${m.content}`
          }).join("\n\n"),
          systemPromptOverride: systemPrompt,
          agentId: `tentacles/${tentacleId}`,
          toolAllowList: ["send_to_user", "web_search", "web_fetch"],
        })
        // Extract send_to_user calls from tool calls (args captured via tool_execution_start event)
        const pushedItems: Array<{ message: string; pushId?: string }> = []
        for (const tc of output.toolCalls) {
          if (tc.name === "send_to_user" && tc.args) {
            const msg = (tc.args as any).message ?? (tc.args as any).text ?? ""
            if (msg) pushedItems.push({ message: msg })
          }
        }
        return {
          content: output.text,
          toolCalls: output.toolCalls.map(tc => ({ name: tc.name })),
          pushedItems: pushedItems.length > 0 ? pushedItems : undefined,
        }
      },
      onConsultationClosed: async (tentacleId, info) => {
        // Archive consultation data to tentacle's session directory and update counters
        brainLogger.info("consultation_archived_multi_turn", {
          tentacle_id: tentacleId,
          consultation_id: info.consultationId,
          turns: info.turns,
          pushed_count: info.pushedCount,
          discarded_count: info.discardedCount,
        })
        // Write a summary archive file to the tentacle's sessions directory
        const sessionsDir = path.join(os.homedir(), ".openceph", "tentacles", tentacleId, "sessions")
        await fs.mkdir(sessionsDir, { recursive: true })
        await fs.writeFile(
          path.join(sessionsDir, `${info.consultationId}.json`),
          JSON.stringify({
            tentacleId,
            consultationId: info.consultationId,
            turns: info.turns,
            pushedCount: info.pushedCount,
            discardedCount: info.discardedCount,
            summary: info.summary,
            archivedAt: new Date().toISOString(),
          }, null, 2),
          "utf-8",
        )
        // Update consultation store with archive info
        await this.consultationStore.update(info.consultationId, {
          status: "closed",
          turn: info.turns,
        })
      },
    })
    this.tentacleManager.setConsultationHandler(async ({ tentacleId, payload }) => {
      if (this.consultationSessionManager) {
        return this.consultationSessionManager.handleConsultationRequest(tentacleId, payload)
      }
      return this.handleTentacleConsultation(tentacleId, payload)
    })
    this.tentacleManager.setConsultationMessageHandler(async ({ tentacleId, payload }) => {
      if (this.consultationSessionManager) {
        await this.consultationSessionManager.handleConsultationMessage(tentacleId, payload)
      }
    })
    this.tentacleManager.setConsultationEndHandler(async ({ tentacleId, payload }) => {
      if (this.consultationSessionManager) {
        await this.consultationSessionManager.handleConsultationEnd(tentacleId, payload)
      }
    })
    // Register tool_request handler: maps openceph_* shared tools to Brain's internal tools
    this.tentacleManager.setToolRequestHandler(async ({ tentacleId, payload }) => {
      const { tool_name, tool_call_id, arguments: args } = payload
      // Map openceph_* prefix to internal tool name (e.g. openceph_web_search -> web_search)
      const internalName = tool_name.startsWith("openceph_") ? tool_name.slice("openceph_".length) : tool_name
      const tool = this.toolRegistry.get(internalName)
      if (!tool) {
        return { tool_call_id, result: {}, success: false, error: `Unknown shared tool: ${tool_name}` }
      }
      try {
        const result = await tool.tool.execute(tool_call_id, args, undefined, undefined, undefined as any)
        const text = result.content?.map((c: any) => c.text ?? "").join("") ?? ""
        return { tool_call_id, result: { text }, success: true }
      } catch (err: any) {
        return { tool_call_id, result: {}, success: false, error: err.message }
      }
    })

    this.tentacleManager.setAdjustmentHandler(async ({ tentacleId, adjustment, currentSchedule }) => {
      const output = await this.runIsolatedTurn({
        sessionKey: `adjustment:${tentacleId}`,
        mode: "minimal",
        message: [
          `Tentacle adjustment request from ${tentacleId}.`,
          `Current schedule: ${JSON.stringify(currentSchedule ?? null)}`,
          `Adjustment: ${JSON.stringify(adjustment)}`,
          'Reply with exactly one word: "approve" or "reject".',
        ].join("\n"),
      })
      const approved = output.text.toLowerCase().includes("approve")
      brainLogger.info(approved ? "tentacle_adjustment_approved" : "tentacle_adjustment_rejected", {
        tentacle_id: tentacleId,
        type: adjustment.type,
      })
      return approved
    })
    await this.skillLoader.loadAll()

    if (!this.skillSpawner) {
      const codeAgent = new CodeAgent(this.piCtx, this.config)
      const credentialStore = new (await import("../config/credential-store.js")).CredentialStore(
        path.join(os.homedir(), ".openceph", "credentials"),
      )
      this.skillSpawner = new SkillSpawner(
        this.config,
        this.skillLoader,
        this.tentacleManager,
        codeAgent,
        credentialStore,
      )

      // Initialize lifecycle and review engines
      this.lifecycleManager = new TentacleLifecycleManager(
        this.tentacleManager,
        this.cronScheduler,
        codeAgent,
        this.tentacleRegistry,
        this.healthCalculator,
      )
      this.reviewEngine = new TentacleReviewEngine(
        this.tentacleManager,
        this.healthCalculator,
        this.memoryManager,
        this.outboundQueue,
      )

      for (const entry of createTentacleTools(
        this.tentacleManager,
        this.config.logging.logDir,
        this.skillSpawner,
        this.lifecycleManager,
        this.reviewEngine,
      )) {
        this.toolRegistry.register(entry)
      }

      for (const entry of createCodeTools({
        config: this.config,
        piCtx: this.piCtx,
        tentacleManager: this.tentacleManager,
        resolveSessionKey: async (sessionFile) => {
          return await this.sessionStore.resolveSessionKeyByTranscriptPath(sessionFile)
            ?? await new SessionStoreManager("cron").resolveSessionKeyByTranscriptPath(sessionFile)
        },
      })) {
        this.toolRegistry.register(entry)
      }
    }

    // Auto-generate TOOLS.md from registered tools so it's always in sync
    await this.syncToolsMd()

    brainLogger.info("brain_initialize", {
      model: this.currentModel,
      tools: this.toolRegistry.size,
    })
  }

  /**
   * Write TOOLS.md to workspace dir.
   * Strategy: Load the template TOOLS.md (which contains detailed guidance),
   * then append any registered tools not mentioned in the template.
   * This preserves the hand-written "when to use / when not to use" guidance.
   */
  private async syncToolsMd(): Promise<void> {
    const toolsMdPath = path.join(this.piCtx.workspaceDir, "TOOLS.md")

    // Read the current TOOLS.md content (contains detailed guidance from template)
    let templateContent = ""
    try {
      templateContent = await fs.readFile(toolsMdPath, "utf-8")
      // Strip any previously appended auto-generated section for clean re-sync
      const autoGenMarker = "\n\n## 其他已注册工具\n"
      const markerIdx = templateContent.indexOf(autoGenMarker)
      if (markerIdx !== -1) {
        templateContent = templateContent.slice(0, markerIdx)
      }
    } catch {
      // File doesn't exist yet — will be created below
    }

    // Collect all registered tools
    const allTools = this.toolRegistry.getAll()

    // Find tools not mentioned in the template
    const unmentionedTools: { name: string; group: string; description: string }[] = []
    for (const entry of allTools) {
      if (!templateContent.includes(entry.name)) {
        unmentionedTools.push({ name: entry.name, group: entry.group, description: entry.description })
      }
    }

    // If template exists and covers all tools, just keep it as-is
    if (templateContent && unmentionedTools.length === 0) {
      // Template is complete — no need to modify
      return
    }

    // If template exists but some tools are missing, append them
    if (templateContent && unmentionedTools.length > 0) {
      const groupLabels: Record<string, string> = {
        user: "核心工具", messaging: "消息工具", memory: "记忆工具",
        web: "网页工具", sessions: "会话工具", skill: "技能工具",
        heartbeat: "Heartbeat 工具", tentacle: "触手工具",
        code: "代码工具", mcp: "MCP 工具",
      }
      const grouped = new Map<string, typeof unmentionedTools>()
      for (const t of unmentionedTools) {
        const list = grouped.get(t.group) || []
        list.push(t)
        grouped.set(t.group, list)
      }
      let appendix = "\n\n## 其他已注册工具\n"
      for (const [group, tools] of grouped) {
        appendix += `\n### ${groupLabels[group] || group}\n`
        for (const t of tools) {
          appendix += `${t.name} — ${t.description}\n`
        }
      }
      await fs.writeFile(toolsMdPath, templateContent + appendix, "utf-8")
      return
    }

    // No template at all — generate from scratch (backward compat)
    const groups = new Map<string, { name: string; description: string }[]>()
    for (const entry of allTools) {
      const list = groups.get(entry.group) || []
      list.push({ name: entry.name, description: entry.description })
      groups.set(entry.group, list)
    }
    const groupLabels: Record<string, string> = {
      user: "核心工具", messaging: "消息工具", memory: "记忆工具",
      web: "网页工具", sessions: "会话工具", skill: "技能工具",
      heartbeat: "Heartbeat 工具", tentacle: "触手工具",
      code: "代码工具", mcp: "MCP 工具",
    }
    let md = "# TOOLS.md — 工具使用指南\n"
    for (const [group, tools] of groups) {
      md += `\n## ${groupLabels[group] || group}\n`
      for (const t of tools) {
        md += `${t.name} — ${t.description}\n`
      }
    }
    md += `\n## 工具使用原则\n`
    md += `- 能直接回答的不调工具\n`
    md += `- 当前这轮对话的正常回复，直接输出文本；不要调用 send_to_user\n`
    md += `- send_to_user 只用于主动通知、异步提醒、非当前会话的外呼\n`
    md += `- 用户说"搜一下""查一下""找一下""新闻"等需要实时信息时，必须调用 web_search\n`
    md += `- 如果没有实际调用过 web_search，绝不能声称"已经搜过了"\n`
    md += `- 搜索结果直接在回复中总结，不需要再调用 send_to_user\n`
    md += `- web_fetch 不执行 JS，JS 重度页面需注意\n`
    md += `- 调用 invoke_code_agent / spawn_from_skill 后，必须按 tool result 原样区分 generated、deployed、spawned、running，禁止把 deployed 说成已运行\n`
    md += `- 只有 tool result 明确给出 spawned=true 或运行态证据时，才能说"已启动/后台运行"\n`
    md += `- 只能引用 tool result 或状态系统返回的真实日志路径，禁止臆造 logs/ 目录\n`
    await fs.writeFile(toolsMdPath, md, "utf-8")
  }

  /** Register additional tools (e.g. MCP tools discovered after Brain construction) */
  async registerTools(entries: import("../tools/index.js").ToolRegistryEntry[]): Promise<void> {
    for (const entry of entries) {
      this.toolRegistry.register(entry)
    }
    brainLogger.info("tools_registered", {
      added: entries.length,
      total: this.toolRegistry.size,
      names: entries.map(e => e.name),
    })
    // Re-sync TOOLS.md with the new tools
    await this.syncToolsMd()
  }

  async handleMessage(input: BrainInput): Promise<BrainOutput> {
    await this.processConsultationUserReply(input)

    // Check for push feedback signals in user message
    const feedbackSignal = detectFeedbackSignal(input.text)
    if (feedbackSignal) {
      brainLogger.info("push_feedback_signal_detected", { signal: feedbackSignal })
      await this.recordFeedbackForRecentPush(input.channel, input.senderId, feedbackSignal)
    }

    const selectedModel = await this.getSelectedModel(input.sessionKey)
    const output = await this.executeTurn({
      text: input.text,
      channel: input.channel,
      senderId: input.senderId,
      sessionKey: input.sessionKey,
      isDm: input.isDm,
      onTextDelta: input.onTextDelta,
      mode: "full",
      model: selectedModel,
      thinkingLevel: input.thinkingLevelOverride,
      reasoningEnabled: input.reasoningEnabledOverride,
    })

    // After handling user message, check if there's pending push content
    try {
      await this.deliverDeferredMessages("user_message", {
        channel: input.channel,
        senderId: input.senderId,
      })
      const pushDecision = await this.pushEngine.evaluate({
        type: "user_message",
        lastInteractionAt: new Date().toISOString(),
      })
      if (pushDecision.shouldPush && pushDecision.consolidatedText) {
        // Append push content to the reply
        output.text += `\n\n---\n📬 **触手动态：**\n${pushDecision.consolidatedText}`
        // Mark items as sent
        await this.outboundQueue.markSentBatch(pushDecision.items.map((i) => i.itemId))
        await this.pushEngine.recordPush()
        this.rememberDeliveredPush(input.channel, input.senderId, pushDecision.items)
        brainLogger.info("push_delivered_piggyback", {
          item_count: pushDecision.items.length,
          trigger: "user_message",
        })
      }
    } catch (err: any) {
      brainLogger.warn("push_evaluate_error", { error: err.message })
    }

    return output
  }

  async runHeartbeatTurn(text: string): Promise<BrainOutput> {
    const { modelId } = resolveRunnableModel({
      piCtx: this.piCtx,
      config: this.config,
      preferredModel: this.config.heartbeat.model,
    })
    return this.executeTurn({
      text,
      channel: "system",
      senderId: "system:heartbeat",
      sessionKey: `agent:ceph:${this.config.session.mainKey}`,
      isDm: true,
      mode: "full",
      model: modelId,
    })
  }

  async runIsolatedTurn(params: {
    sessionKey: string
    message: string
    model?: string
    mode?: "full" | "minimal"
    thinking?: string
    systemPromptOverride?: string
    agentId?: string
    toolAllowList?: string[]
  }): Promise<BrainOutput> {
    const resolution = resolveRunnableModel({
      piCtx: this.piCtx,
      config: this.config,
      preferredModel: params.model ?? this.config.heartbeat.model,
    })
    const model = resolution.modelId
    const cronSessionStore = new SessionStoreManager(params.agentId ?? "cron")
    const sessionEntry = await cronSessionStore.getOrCreate(params.sessionKey, {
      model,
      origin: { channel: "cron", senderId: "cron:system" },
    })
    await cronSessionStore.updateModel(params.sessionKey, model)
    let customTools = this.toolRegistry.getPiTools()
    if (params.toolAllowList) {
      const allowed = new Set(params.toolAllowList)
      customTools = customTools.filter((t: any) => allowed.has(t.name))
    }
    brainLogger.info("isolated_turn_tools", {
      session_key: params.sessionKey,
      tool_count: customTools.length,
      tool_names: customTools.map((t: any) => t.name),
    })
    const systemPrompt = params.systemPromptOverride ?? await this.buildSystemPrompt({
      channel: "cron",
      isDm: true,
      model,
      mode: params.mode ?? "minimal",
      thinkingLevel: normalizeThinkingLevel(params.thinking ?? this.currentThinkingLevel),
      reasoningEnabled: this.reasoningEnabled,
    })
    const transcriptPath = cronSessionStore.getTranscriptPath(sessionEntry.sessionId)
    const session = await createBrainSession(this.piCtx, this.config, {
      sessionFilePath: transcriptPath,
      modelId: model,
      systemPrompt,
      customTools,
      thinkingLevel: normalizeThinkingLevel(params.thinking ?? this.currentThinkingLevel),
    })

    // BUG7 fix: write system_prompt to session JSONL for debugging
    try {
      const promptRecord = JSON.stringify({
        type: "system_prompt",
        timestamp: new Date().toISOString(),
        content: systemPrompt.slice(0, 50000),
        sessionKey: params.sessionKey,
      })
      await import("fs/promises").then(fsp => fsp.appendFile(transcriptPath, promptRecord + "\n", "utf-8"))
    } catch { /* non-critical */ }

    let replyText = ""
    let errorMessage = ""
    const toolCalls: ToolCallRecord[] = []
    const pendingArgs = new Map<string, Record<string, unknown>>()
    const unsubscribe = session.session.subscribe((event: any) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        replyText += event.assistantMessageEvent.delta
      } else if (event.type === "message_complete" && event.message?.errorMessage) {
        errorMessage = event.message.errorMessage
      } else if (event.type === "tool_execution_start") {
        if (event.args) pendingArgs.set(event.toolCallId, event.args)
      } else if (event.type === "tool_execution_end") {
        toolCalls.push({ name: event.toolName, success: !event.isError, args: pendingArgs.get(event.toolCallId) })
        pendingArgs.delete(event.toolCallId)
      }
    })

    const statsBefore = session.session.getSessionStats()
    const startedAt = Date.now()
    try {
      await session.session.prompt(params.message)
    } finally {
      unsubscribe()
    }
    const statsAfter = session.session.getSessionStats()
    const inputTokens = statsAfter.tokens.input - statsBefore.tokens.input
    const outputTokens = statsAfter.tokens.output - statsBefore.tokens.output
    const cacheReadTokens = statsAfter.tokens.cacheRead - statsBefore.tokens.cacheRead
    const cacheWriteTokens = statsAfter.tokens.cacheWrite - statsBefore.tokens.cacheWrite
    await cronSessionStore.updateTokens(params.sessionKey, { input: inputTokens, output: outputTokens })

    return {
      text: replyText,
      errorMessage: errorMessage || undefined,
      toolCalls,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      model,
      durationMs: Date.now() - startedAt,
    }
  }

  async registerCronScheduler(cronScheduler: CronScheduler): Promise<void> {
    this.cronScheduler = cronScheduler
    this.tentacleManager.setCronScheduler(cronScheduler)
    for (const entry of createCronTools(cronScheduler)) {
      this.toolRegistry.register(entry)
    }
    await this.syncToolsMd()
  }

  registerHeartbeatScheduler(heartbeatScheduler: HeartbeatScheduler): void {
    this.heartbeatScheduler = heartbeatScheduler
  }

  private async executeTurn(params: {
    text: string
    channel: string
    senderId: string
    sessionKey: string
    isDm: boolean
    onTextDelta?: (delta: string) => void
    mode: "full" | "minimal"
    model: string
    thinkingLevel?: ThinkingLevel
    reasoningEnabled?: boolean
  }): Promise<BrainOutput> {
    const startTime = Date.now()
    if (!params.senderId.startsWith("system:")) {
      this.lastActiveChannel = params.channel
      this.lastActiveSenderId = params.senderId
    }

    const sessionEntry = await this.sessionStore.getOrCreate(params.sessionKey, {
      model: params.model,
      origin: { channel: params.channel, senderId: params.senderId },
    })
    const sessionChanged =
      this.currentSessionKey !== params.sessionKey || this.activeSessionId !== sessionEntry.sessionId
    const modelChanged = this.currentModel !== params.model
    if (sessionChanged || modelChanged) {
      this.session = null
      this.totalInputTokens = sessionEntry.inputTokens
      this.totalOutputTokens = sessionEntry.outputTokens
    }
    this.currentSessionKey = params.sessionKey
    this.activeSessionId = sessionEntry.sessionId
    this.currentModel = params.model
    await this.sessionStore.updateModel(params.sessionKey, params.model)

    const failoverDecision = this.modelFailover.checkContextLimit(
      this.totalInputTokens + this.totalOutputTokens,
      params.model,
    )
    if (failoverDecision.action === "switch" && failoverDecision.suggestedModel) {
      brainLogger.info("model_failover_suppressed", {
        session_key: params.sessionKey,
        current_model: params.model,
        suggested_model: failoverDecision.suggestedModel,
        reason: failoverDecision.reason,
      })
    }

    const systemPrompt = await this.buildSystemPrompt({
      channel: params.channel,
      isDm: params.isDm,
      model: params.model,
      mode: params.mode,
      thinkingLevel: params.thinkingLevel ?? this.currentThinkingLevel,
      reasoningEnabled: params.reasoningEnabled ?? this.reasoningEnabled,
    })

    if (!this.session) {
      const customTools = this.toolRegistry.getPiTools()
      brainLogger.info("session_create", {
        session_id: sessionEntry.sessionId,
        model: params.model,
        custom_tools_count: customTools.length,
        custom_tool_names: customTools.map((t) => t.name),
      })
      this.session = await createBrainSession(this.piCtx, this.config, {
        sessionFilePath: this.sessionStore.getTranscriptPath(sessionEntry.sessionId),
        modelId: params.model,
        systemPrompt,
        customTools,
        thinkingLevel: params.thinkingLevel ?? this.currentThinkingLevel,
      })
    }
    this.session.session.setThinkingLevel(params.thinkingLevel ?? this.currentThinkingLevel)

    let replyText = ""
    let errorMessage = ""
    const toolCalls: ToolCallRecord[] = []
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let loopAborted = false
    const loopDetector = new LoopDetector(this.config.tools.loopDetection)
    const pendingToolArgs = new Map<string, unknown>()

    const unsubscribe = this.session.session.subscribe((event: any) => {
      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent?.type === "text_delta") {
            replyText += event.assistantMessageEvent.delta
            params.onTextDelta?.(event.assistantMessageEvent.delta)
          }
          break
        case "message_complete":
          if (event.message?.stopReason === "error" && event.message?.errorMessage) {
            errorMessage = event.message.errorMessage
            brainLogger.error("api_error", {
              session_id: sessionEntry.sessionId,
              error: event.message.errorMessage,
            })
          }
          break
        case "tool_execution_start":
          pendingToolArgs.set(event.toolCallId, event.args)
          brainLogger.info("tool_call", {
            session_id: sessionEntry.sessionId,
            tool: event.toolName,
          })
          break
        case "tool_execution_end":
          loopDetector.record(event.toolName, pendingToolArgs.get(event.toolCallId), event.result)
          pendingToolArgs.delete(event.toolCallId)
          brainLogger.info("tool_result", {
            session_id: sessionEntry.sessionId,
            tool: event.toolName,
            success: !event.isError,
          })
          toolCalls.push({
            name: event.toolName,
            success: !event.isError,
          })
          {
            const loopResult = loopDetector.check()
            if (loopResult.detected) {
              brainLogger.warn("loop_detected", {
                session_id: sessionEntry.sessionId,
                level: loopResult.level,
                detector: loopResult.detector,
                message: loopResult.message,
              })
              if (loopResult.level === "critical" && !loopAborted) {
                loopAborted = true
                void this.session?.session.abort()
              }
            }
          }
          break
      }
    })

    brainLogger.info("streaming_start", { session_id: sessionEntry.sessionId })
    const statsBefore = this.session.session.getSessionStats()

    try {
      await this.session.session.prompt(params.text)
    } finally {
      unsubscribe()
    }

    const statsAfter = this.session.session.getSessionStats()
    inputTokens = statsAfter.tokens.input - statsBefore.tokens.input
    outputTokens = statsAfter.tokens.output - statsBefore.tokens.output
    cacheReadTokens = statsAfter.tokens.cacheRead - statsBefore.tokens.cacheRead
    cacheWriteTokens = statsAfter.tokens.cacheWrite - statsBefore.tokens.cacheWrite

    const durationMs = Date.now() - startTime
    if (loopAborted && !replyText.trim()) {
      replyText = "检测到工具调用循环，已中止。"
    }

    // Empty response guard: if no text and no tool calls, return a friendly message
    if (!replyText.trim() && toolCalls.length === 0 && !errorMessage) {
      brainLogger.warn("empty_response", {
        session_id: sessionEntry.sessionId,
        model: params.model,
      })
      replyText = "抱歉，我刚才没有生成有效回复，请再说一次。"
    }

    brainLogger.info("streaming_end", {
      session_id: sessionEntry.sessionId,
      chars: replyText.length,
      duration_ms: durationMs,
    })
    await this.writeRuntimeStatus()

    costLogger.info("api_call", {
      session_id: sessionEntry.sessionId,
      model: params.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      duration_ms: durationMs,
    })

    if (this.config.logging.cacheTrace) {
      writeCacheTrace({
        session_id: sessionEntry.sessionId,
        model: params.model,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      })
    }

    await this.sessionStore.updateTokens(params.sessionKey, {
      input: inputTokens,
      output: outputTokens,
    })
    this.totalInputTokens += inputTokens
    this.totalOutputTokens += outputTokens
    if (!params.senderId.startsWith("system:") && params.channel !== "cron") {
      this.turnsSinceHeartbeat++
      if (
        this.heartbeatScheduler &&
        this.config.heartbeat.checkAfterTurns > 0 &&
        this.turnsSinceHeartbeat >= this.config.heartbeat.checkAfterTurns
      ) {
        this.turnsSinceHeartbeat = 0
        void this.heartbeatScheduler.triggerNow()
      }
    }

    return {
      text: replyText,
      errorMessage: errorMessage || undefined,
      toolCalls,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      model: params.model,
      durationMs,
    }
  }

  getSessionStatus(): SessionStatusInfo {
    return {
      sessionKey: this.currentSessionKey,
      model: this.currentModel,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      activeTentacles: this.tentacleManager.listAll({ status: "running" }).length,
      todayCostUsd: 0,
    }
  }

  async resetSession(newModel?: string, sessionKey?: string): Promise<void> {
    const key = sessionKey || this.currentSessionKey
    let resetEntry
    if (key) {
      await this.sessionStore.getOrCreate(key, {
        model: newModel ?? this.config.agents.defaults.model.primary,
      })
      if (newModel) {
        await this.sessionStore.updateModel(key, newModel)
      }
      resetEntry = await this.sessionStore.reset(key, "manual")
    }
    if (!key || key === this.currentSessionKey) {
      this.session = null
      this.activeSessionId = resetEntry?.sessionId ?? ""
      this.totalInputTokens = 0
      this.totalOutputTokens = 0
      this.currentModel = resetEntry?.model ?? newModel ?? this.config.agents.defaults.model.primary
    }
    brainLogger.info("session_reset", {
      session_key: key,
      new_model: this.currentModel,
    })
  }

  async shutdown(): Promise<void> {
    await this.tentacleManager.shutdown()
    await this.ipcServer.stop()
    this.session = null
    brainLogger.info("brain_shutdown", {})
  }

  get model(): string {
    return this.currentModel
  }

  async getSelectedModel(sessionKey?: string): Promise<string> {
    const key = sessionKey?.trim() || this.currentSessionKey
    if (!key) {
      return this.config.agents.defaults.model.primary
    }
    const entry = await this.sessionStore.get(key)
    return entry?.model ?? this.config.agents.defaults.model.primary
  }

  get thinkingLevel(): ThinkingLevel {
    return this.currentThinkingLevel
  }

  get reasoningMode(): boolean {
    return this.reasoningEnabled
  }

  listTentacles(): ReturnType<TentacleManager["listAll"]> {
    return this.tentacleManager.listAll()
  }

  async listSkills(): Promise<string[]> {
    const skills = await this.skillLoader.loadAll()
    return skills.map((skill) => skill.name)
  }

  listToolNames(): string[] {
    return this.toolRegistry.getAll().map((entry) => entry.name).sort()
  }

  getLastActiveTarget(channel = "last"): { channel: string; senderId: string; recipientId?: string } | null {
    return {
      channel: channel === "last" ? this.lastActiveChannel : channel,
      senderId: this.lastActiveSenderId,
      recipientId: this.lastActiveSenderId,
    }
  }

  async triggerTentacleCron(tentacleId: string, jobId: string): Promise<boolean> {
    return this.tentacleManager.triggerCronJob(jobId, tentacleId)
  }

  async triggerTentacleHeartbeat(tentacleId: string, prompt: string, jobId: string): Promise<boolean> {
    return this.tentacleManager.triggerHeartbeatReview(tentacleId, prompt, jobId)
  }

  getTentacleManager(): TentacleManager {
    return this.tentacleManager
  }

  async getPendingReportCount(): Promise<number> {
    return this.pendingReports.size()
  }

  getOutboundQueue(): OutboundQueue {
    return this.outboundQueue
  }

  getPushEngine(): PushDecisionEngine {
    return this.pushEngine
  }

  getFeedbackTracker(): PushFeedbackTracker {
    return this.feedbackTracker
  }

  getHealthCalculator(): TentacleHealthCalculator {
    return this.healthCalculator
  }

  getReviewEngine(): TentacleReviewEngine | null {
    return this.reviewEngine
  }

  /**
   * Evaluate push decision for non-user-message triggers (heartbeat, daily-review, urgent).
   */
  async evaluatePush(trigger: PushTrigger): Promise<string | null> {
    const decision = await this.pushEngine.evaluate(trigger)
    if (!decision.shouldPush || !decision.consolidatedText) return null

    await this.outboundQueue.markSentBatch(decision.items.map((i) => i.itemId))
    await this.pushEngine.recordPush()
    this.rememberDeliveredPush(this.lastActiveChannel, this.lastActiveSenderId, decision.items)
    brainLogger.info("push_delivered", {
      item_count: decision.items.length,
      trigger_type: trigger.type,
      reason: decision.reason,
    })
    return decision.consolidatedText
  }

  async runDailyReviewAutomation(): Promise<string> {
    const sections: string[] = []

    const deferred = await this.deliverDeferredMessages("best_time_window")
    if (deferred.deliveredCount > 0) {
      sections.push(`Deferred user messages delivered: ${deferred.deliveredCount}`)
    }

    if (this.reviewEngine && this.lifecycleManager) {
      const actions = await this.reviewEngine.review()
      const applied: string[] = []

      for (const action of actions) {
        if (action.requiresUserConfirm) continue
        if (action.action === "weaken") {
          await this.lifecycleManager.weaken(action.tentacleId)
          applied.push(`${action.tentacleId}: weaken`)
        } else if (action.action === "strengthen") {
          await this.lifecycleManager.strengthen(action.tentacleId, {})
          applied.push(`${action.tentacleId}: strengthen`)
        }
      }

      if (applied.length > 0) {
        sections.push(`Review actions applied:\n- ${applied.join("\n- ")}`)
      }
    }

    const pushText = await this.evaluatePush({ type: "daily_review" })
    if (pushText) {
      sections.push(`Pending push digest:\n${pushText}`)
    }

    return sections.length > 0 ? sections.join("\n\n") : "HEARTBEAT_OK"
  }

  async runMorningDigestFallback(): Promise<string> {
    const sections: string[] = []
    const deferred = await this.deliverDeferredMessages("morning_digest")
    if (deferred.deliveredCount > 0) {
      sections.push(`Delivered ${deferred.deliveredCount} deferred message(s).`)
    }

    const pushText = await this.evaluatePush({ type: "daily_review" })
    if (pushText) {
      sections.push(pushText)
    }

    return sections.length > 0 ? sections.join("\n\n") : "HEARTBEAT_OK"
  }

  setThinkingLevel(level: string): ThinkingLevel {
    this.currentThinkingLevel = normalizeThinkingLevel(level)
    this.session?.session.setThinkingLevel(this.currentThinkingLevel)
    return this.currentThinkingLevel
  }

  setReasoningEnabled(enabled: boolean): void {
    this.reasoningEnabled = enabled
  }

  async compactSession(customInstructions?: string): Promise<string> {
    if (!this.session) {
      return "Nothing to compact."
    }
    try {
      const result = await this.session.session.compact(customInstructions)

      // Check if post-compaction tokens still exceed limit → failover
      const totalTokens = this.totalInputTokens + this.totalOutputTokens
      const failoverDecision = this.modelFailover.checkContextLimit(totalTokens, this.currentModel)
      if (failoverDecision.action === "switch" && failoverDecision.suggestedModel) {
        brainLogger.info("model_failover_after_compact_suppressed", {
          current_model: this.currentModel,
          suggested_model: failoverDecision.suggestedModel,
          reason: failoverDecision.reason,
        })
      }

      return `Compacted session. Tokens before: ${result.tokensBefore}.`
    } catch (err: any) {
      brainLogger.error("compaction_failed_fallback", {
        error: err.message,
        session_key: this.currentSessionKey,
      })

      try {
        await this.sessionStore.reset(this.currentSessionKey, "manual")
        this.session = null
        return "对话历史已重置，重要信息已保存到记忆中。"
      } catch (resetErr: any) {
        brainLogger.error("compaction_fallback_reset_failed", { error: resetErr.message })
        return `Compaction failed: ${err.message}. Session reset also failed.`
      }
    }
  }

  /**
   * Check context pressure and potentially switch to fallback model.
   * Called periodically or after heavy turns.
   */
  checkAndFailover(): FailoverDecision {
    const totalTokens = this.totalInputTokens + this.totalOutputTokens
    return this.modelFailover.checkContextLimit(totalTokens, this.currentModel)
  }

  private async writeRuntimeStatus(): Promise<void> {
    await updateRuntimeStatus((current) => ({
      ...current,
      brain: {
        running: true,
        pid: process.pid,
        model: this.currentModel,
        sessionKey: this.currentSessionKey,
        inputTokens: this.totalInputTokens,
        outputTokens: this.totalOutputTokens,
        updatedAt: new Date().toISOString(),
      },
    }))
  }

  async runCronJob(jobId: string): Promise<void> {
    if (!this.cronScheduler) {
      throw new Error("Cron scheduler not ready")
    }
    await this.cronScheduler.runJob(jobId, "force")
  }

  getCronJob(jobId: string) {
    return this.cronScheduler?.getJob(jobId)
  }

  private async handleTentacleConsultation(
    tentacleId: string,
    payload: ConsultationRequestPayload,
  ): Promise<ConsultationReplyPayload> {
    const session = await this.upsertConsultationSession(tentacleId, payload)
    const queuedItems = await this.queueConsultationItems(tentacleId, payload, session.sessionId)
    const approvedItemIds = queuedItems.map((item) => item.itemId)
    const questions = payload.mode === "action_confirm" && !payload.action?.content
      ? ["Please provide the action content before execution."]
      : undefined

    let decision: ConsultationReplyPayload["decision"] = "discard"
    let status: ConsultationReplyPayload["status"] = "closed"
    let nextAction: ConsultationReplyPayload["next_action"] = "none"

    if (questions?.length) {
      decision = "question"
      status = "waiting_tentacle"
      nextAction = "await_tentacle"
    } else if (payload.mode === "action_confirm") {
      decision = queuedItems.length > 0 ? "send" : "defer"
      status = "waiting_user"
      nextAction = "await_user"
    } else if (queuedItems.length > 0) {
      decision = "send"
      status = "resolved"
    }

    await this.consultationStore.update(session.sessionId, {
      status: mapReplyStatusToStore(status),
      recentPushItemIds: queuedItems.map((item) => item.itemId),
      lastTentacleReplyAt: new Date().toISOString(),
    })

    const logEvent = payload.mode === "action_confirm"
      ? "consultation_action_confirm"
      : "consultation_batch_received"
    brainLogger.info(logEvent, {
      tentacle_id: tentacleId,
      request_id: payload.request_id,
      session_id: session.sessionId,
      mode: payload.mode,
      queued_push_count: queuedItems.length,
    })

    if (queuedItems.length > 0) {
      await this.deliverPushNow(queuedItems, session.sessionId)
    }

    return {
      session_id: session.sessionId,
      requestId: payload.request_id,
      status,
      decision,
      approvedItemIds,
      queuedPushCount: queuedItems.length,
      notes: queuedItems.length > 0
        ? `Queued ${queuedItems.length} push item(s) for user delivery`
        : "No items met push threshold; kept as internal reference",
      questions,
      next_action: nextAction,
    }
  }

  private async queueConsultationItems(
    tentacleId: string,
    payload: ConsultationRequestPayload,
    sessionId: string,
  ): Promise<ApprovedPushItem[]> {
    const queued: ApprovedPushItem[] = []

    if (payload.mode === "action_confirm" && payload.action) {
      const priority = urgencyFromText(`${payload.summary}\n${payload.action.description}`)
      const item: ApprovedPushItem = {
        itemId: `${payload.request_id}:${payload.action.type}`,
        tentacleId,
        content: `${payload.summary}\n${payload.action.description}${payload.action.content ? `\n\n${payload.action.content}` : ""}`,
        originalItems: [],
        priority,
        timelinessHint: "immediate",
        needsUserAction: true,
        approvedAt: new Date().toISOString(),
        status: "pending",
      }
      await this.outboundQueue.addApprovedItem(item)
      queued.push(item)
      return queued
    }

    for (const item of payload.items ?? []) {
      if (item.tentacleJudgment === "uncertain") continue
      const priority = item.tentacleJudgment === "important"
        ? urgencyFromText(`${item.content}\n${item.reason}`)
        : "normal"
      const pushItem: ApprovedPushItem = {
        itemId: `${payload.request_id}:${item.id}`,
        tentacleId,
        content: item.content,
        originalItems: [item.id],
        priority,
        timelinessHint: timelinessFromPriority(priority),
        needsUserAction: false,
        approvedAt: new Date().toISOString(),
        status: "pending",
      }
      await this.outboundQueue.addApprovedItem(pushItem)
      queued.push(pushItem)
    }

    if (queued.length > 0) {
      await this.consultationStore.update(sessionId, {
        recentPushItemIds: queued.map((item) => item.itemId),
      })
    }

    return queued
  }

  private rememberDeliveredPush(channel: string, senderId: string, items: ApprovedPushItem[], messageId?: string): void {
    if (!channel || !senderId || items.length === 0) return
    const key = `${channel}:${senderId}`
    this.recentPushContext.set(key, {
      messageId: messageId ?? `push:${Date.now()}`,
      itemIds: items.map((item) => item.itemId),
      tentacleIds: Array.from(new Set(items.map((item) => item.tentacleId))),
      deliveredAt: new Date().toISOString(),
    })
  }

  private async recordFeedbackForRecentPush(
    channel: string,
    senderId: string,
    reaction: "positive" | "negative",
  ): Promise<void> {
    const key = `${channel}:${senderId}`
    const recent = this.recentPushContext.get(key)
    if (!recent) return

    const ageMs = Date.now() - new Date(recent.deliveredAt).getTime()
    const maxAgeMs = (this.config.push.feedback?.ignoreWindowHours ?? 24) * 60 * 60 * 1000
    if (ageMs > maxAgeMs) {
      this.recentPushContext.delete(key)
      return
    }

    await this.feedbackTracker.recordFeedback({
      messageId: recent.messageId,
      sourceTentacles: recent.tentacleIds,
      reaction,
      timestamp: new Date().toISOString(),
    })
    this.recentPushContext.delete(key)
  }

  private async processConsultationUserReply(input: BrainInput): Promise<void> {
    const key = `${input.channel}:${input.senderId}`
    const recent = this.recentPushContext.get(key)
    if (!recent) return

    const sessionId = this.pushMessageToConsultationSession.get(recent.messageId)
    if (!sessionId) return

    const session = await this.consultationStore.get(sessionId)
    if (!session || session.status !== "waiting_user") return

    const lowered = input.text.toLowerCase()
    const approved = /(可以|同意|发布|发吧|approve|approved|ok|好的)/.test(lowered)
    const rejected = /(不要|拒绝|rejected|reject|不发布|取消)/.test(lowered)
    const decision = approved ? "approved" : rejected ? "rejected" : "revise"

    await this.consultationStore.update(sessionId, {
      status: "waiting_tentacle",
      lastUserFeedback: input.text,
      lastUserFeedbackAt: new Date().toISOString(),
    })

    await this.tentacleManager.forwardConsultationDirective(session.tentacleId, {
      session_id: sessionId,
      decision,
      feedback: input.text,
      action: session.actionType ? {
        type: session.actionType,
        approved,
        content: session.actionContent,
      } : undefined,
    })
  }

  private async upsertConsultationSession(
    tentacleId: string,
    payload: ConsultationRequestPayload,
  ): Promise<ConsultationSessionRecord> {
    const existing = payload.session_id
      ? await this.consultationStore.get(payload.session_id)
      : null
    if (existing) {
      const requestIds = Array.from(new Set([...existing.requestIds, payload.request_id]))
      return (await this.consultationStore.update(existing.sessionId, {
        requestIds,
        turn: payload.turn ?? existing.turn + 1,
        updatedAt: new Date().toISOString(),
        actionType: payload.action?.type ?? existing.actionType,
        actionDescription: payload.action?.description ?? existing.actionDescription,
        actionContent: payload.action?.content ?? existing.actionContent,
        status: payload.mode === "action_confirm" ? "waiting_user" : existing.status,
      })) ?? existing
    }

    const sessionId = payload.session_id ?? crypto.randomUUID()
    return this.consultationStore.upsert({
      sessionId,
      tentacleId,
      mode: payload.mode as any,
      status: payload.mode === "action_confirm" ? "waiting_user" : "open",
      requestIds: [payload.request_id],
      turn: payload.turn ?? 1,
      actionType: payload.action?.type,
      actionDescription: payload.action?.description,
      actionContent: payload.action?.content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  private async deliverPushNow(items: ApprovedPushItem[], sessionId?: string): Promise<void> {
    if (items.length === 0) return
    const text = items.length === 1
      ? items[0].content
      : items.map((item, index) => `${index + 1}. ${item.content}`).join("\n")
    const sourceTentacles = Array.from(new Set(items.map((item) => item.tentacleId)))
    const priority = items.some((item) => item.priority === "urgent") ? "urgent" : "normal"

    const result = await executeSendToUser(
      {
        message: text,
        timing: "immediate",
        priority,
        channel: "last_active",
        source_tentacles: sourceTentacles,
      },
      {
        currentSessionKey: sessionId ? `consultation:${sessionId}` : "consultation:auto",
        mainSessionKey: `agent:ceph:${this.config.session.mainKey}`,
        deliverToUser: this.deliverToUser,
        lastActiveChannel: () => this.lastActiveChannel,
        lastActiveSenderId: () => this.lastActiveSenderId,
        sessionStore: this.sessionStore,
        onConsultationPush: async (payload) => {
          this.rememberDeliveredPush(payload.channel, payload.senderId, items, payload.pushId)
          if (sessionId) {
            this.pushMessageToConsultationSession.set(payload.pushId, sessionId)
            await this.consultationStore.update(sessionId, {
              recentPushMessageId: payload.pushId,
            })
          }
        },
      },
    )

    const delivered = (result.details as any)?.delivered !== false
    if (delivered) {
      await this.outboundQueue.markSentBatch(items.map((item) => item.itemId))
    }
  }

  private async deliverDeferredMessages(
    mode: "user_message" | "best_time_window" | "morning_digest",
    targetOverride?: { channel: string; senderId: string },
  ): Promise<{ deliveredCount: number }> {
    if (!this.deliverToUser) return { deliveredCount: 0 }

    const pending = await this.outboundQueue.getPendingDeferred()
    if (pending.length === 0) return { deliveredCount: 0 }

    const now = new Date()
    const due = pending.filter((item) => this.isDeferredDue(item, mode, now))
    if (due.length === 0) return { deliveredCount: 0 }

    const bestTimeItems = due.filter((item) => item.timing === "best_time")
    const morningDigestItems = due.filter((item) => item.timing === "morning_digest")

    let deliveredCount = 0
    for (const item of bestTimeItems) {
      const target = {
        channel: targetOverride?.channel ?? item.channel ?? this.lastActiveChannel,
        senderId: targetOverride?.senderId ?? item.senderId ?? this.lastActiveSenderId,
      }
      await this.deliverDeferredItem(item, target)
      deliveredCount++
    }

    const digestGroups = new Map<string, DeferredMessage[]>()
    for (const item of morningDigestItems) {
      const channel = targetOverride?.channel ?? item.channel ?? this.lastActiveChannel
      const senderId = targetOverride?.senderId ?? item.senderId ?? this.lastActiveSenderId
      const key = `${channel}:${senderId}`
      const list = digestGroups.get(key) ?? []
      list.push({ ...item, channel, senderId })
      digestGroups.set(key, list)
    }

    for (const [key, items] of digestGroups) {
      const [channel, senderId] = key.split(":")
      await this.deliverDeferredDigest(items, { channel, senderId })
      deliveredCount += items.length
    }

    return { deliveredCount }
  }

  private isDeferredDue(
    item: DeferredMessage,
    mode: "user_message" | "best_time_window" | "morning_digest",
    now: Date,
  ): boolean {
    if (item.status !== "pending") return false

    if (item.timing === "best_time") {
      if (mode === "user_message") return true
      if (mode === "best_time_window") return this.isWithinPreferredWindow(now)
      if (mode === "morning_digest") {
        return now.getTime() - new Date(item.createdAt).getTime() >= 24 * 60 * 60 * 1000
      }
    }

    if (item.timing === "morning_digest") {
      return mode === "morning_digest"
    }

    return false
  }

  private isWithinPreferredWindow(now: Date): boolean {
    const [startHour, startMinute] = this.config.push.preferredWindowStart.split(":").map((v) => Number(v))
    const [endHour, endMinute] = this.config.push.preferredWindowEnd.split(":").map((v) => Number(v))
    const current = now.getHours() * 60 + now.getMinutes()
    const start = (Number.isFinite(startHour) ? startHour : 9) * 60 + (Number.isFinite(startMinute) ? startMinute : 0)
    const end = (Number.isFinite(endHour) ? endHour : 10) * 60 + (Number.isFinite(endMinute) ? endMinute : 0)
    return current >= start && current <= end
  }

  private async deliverDeferredItem(
    item: DeferredMessage,
    target: { channel: string; senderId: string },
  ): Promise<void> {
    await this.deliverToUser!(
      target,
      {
        text: item.message,
        timing: "immediate",
        priority: item.priority,
        messageId: item.messageId,
      },
    )

    if (item.source === "consultation_session" && item.targetSessionKey) {
      await this.sessionStore.appendAssistantMessage(
        item.targetSessionKey,
        item.message,
        {
          source: "tentacle_push",
          tentacleId: item.tentacleId ?? "unknown",
          pushId: item.messageId,
          consultationSessionId: item.sourceSessionKey ?? "consultation:queued",
          pushedAt: new Date().toISOString(),
        },
      )
      brainLogger.info("push_to_main_session", {
        session_id: item.sourceSessionKey ?? "consultation:queued",
        target_session: item.targetSessionKey,
        push_id: item.messageId,
        tentacle_id: item.tentacleId,
        channel: target.channel,
        timing: item.timing,
        priority: item.priority,
      })
    }

    gatewayLogger.info("push_delivered_from_consultation", {
      push_id: item.messageId,
      tentacle_id: item.tentacleId,
      channel: target.channel,
      delivery_mode: "deferred_single",
    })
    await this.outboundQueue.markDeferredSent([item.messageId])
  }

  private async deliverDeferredDigest(
    items: DeferredMessage[],
    target: { channel: string; senderId: string },
  ): Promise<void> {
    if (items.length === 0) return

    const text = [
      `☀️ 今日简报（${new Date().toISOString().slice(0, 10)}）`,
      "",
      ...items.map((item, index) => `${index + 1}. ${item.message}`),
    ].join("\n\n")
    const messageId = `digest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    await this.deliverToUser!(
      target,
      {
        text,
        timing: "immediate",
        priority: items.some((item) => item.priority === "urgent") ? "urgent" : "normal",
        messageId,
      },
    )

    const consultationItems = items.filter((item) => item.source === "consultation_session" && item.targetSessionKey)
    if (consultationItems.length > 0) {
      await this.sessionStore.appendAssistantMessage(
        consultationItems[0].targetSessionKey!,
        text,
        {
          source: "tentacle_push",
          pushId: messageId,
          consultationSessionId: consultationItems.map((item) => item.sourceSessionKey ?? "consultation:queued").join(","),
          sourceTentacles: Array.from(new Set(consultationItems.map((item) => item.tentacleId).filter(Boolean))),
          pushedAt: new Date().toISOString(),
        },
      )
      brainLogger.info("push_to_main_session", {
        session_id: "consultation:digest",
        target_session: consultationItems[0].targetSessionKey,
        push_id: messageId,
        tentacle_ids: Array.from(new Set(consultationItems.map((item) => item.tentacleId).filter(Boolean))),
        channel: target.channel,
        timing: "morning_digest",
        priority: items.some((item) => item.priority === "urgent") ? "urgent" : "normal",
      })
    }

    gatewayLogger.info("push_delivered_from_consultation", {
      push_id: messageId,
      tentacle_ids: Array.from(new Set(items.map((item) => item.tentacleId).filter(Boolean))),
      channel: target.channel,
      delivery_mode: "morning_digest",
    })
    await this.outboundQueue.markDeferredSent(items.map((item) => item.messageId))
  }

  private async loadSkillsSummary(): Promise<string | undefined> {
    const skills = await new SkillLoader(resolveSkillSearchPaths(this.config)).loadAll()
    if (skills.length === 0) return undefined
    return skills.map((skill) => {
      const tags: string[] = []
      if (skill.isSkillTentacle) tags.push("skill_tentacle")
      else if (skill.spawnable) tags.push("spawnable")
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : ""
      return `${skill.name} — ${skill.description || "No description"}${tagStr}`
    }).join("\n")
  }

  private async buildSystemPrompt(options: {
    channel: string
    isDm: boolean
    model: string
    mode: "full" | "minimal"
    thinkingLevel?: ThinkingLevel
    reasoningEnabled?: boolean
  }): Promise<string> {
    const newWs = await isNewWorkspace(this.piCtx.workspaceDir)
    const promptOptions: SystemPromptOptions = {
      mode: options.mode,
      channel: options.channel,
      isDm: options.isDm,
      isNewWorkspace: newWs,
      model: options.model,
      thinkingLevel: options.thinkingLevel ?? this.currentThinkingLevel,
      hostname: os.hostname(),
      nodeVersion: process.version,
      osPlatform: process.platform,
      osArch: process.arch,
      tentacleSummary: this.listTentacles().length > 0
        ? this.listTentacles().map((item) => `${item.tentacleId} (${item.status})`).join("\n")
        : undefined,
      skillsSummary: await this.loadSkillsSummary(),
      heartbeatSummary: `Heartbeat runs every ${this.config.heartbeat.every} in the main session.\nRead HEARTBEAT.md and check all items. Reply HEARTBEAT_OK if nothing needs attention.\nCron jobs handle precise schedules — use cron_add tool to create scheduled tasks.\nDaily review runs as cron job "daily-review" at 0 22 * * *.`,
    }
    let prompt = await assembleSystemPrompt(this.piCtx.workspaceDir, promptOptions, this.toolRegistry)
    if (options.reasoningEnabled ?? this.reasoningEnabled) {
      prompt += "\n\n# Reasoning Output\nProvide a concise explanation of your reasoning in the final answer."
    }
    return prompt
  }
}

function normalizeThinkingLevel(level: string): ThinkingLevel {
  if (level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "off") {
    return level
  }
  return "off"
}

function urgencyFromText(text: string): ApprovedPushItem["priority"] {
  const lower = text.toLowerCase()
  if (/(urgent|critical|immediate|high priority|紧急|严重|立刻)/.test(lower)) return "urgent"
  if (/(important|action|confirm|review|审阅|确认)/.test(lower)) return "high"
  if (/(reference|summary|digest|参考)/.test(lower)) return "low"
  return "normal"
}

function timelinessFromPriority(priority: ApprovedPushItem["priority"]): ApprovedPushItem["timelinessHint"] {
  if (priority === "urgent") return "immediate"
  if (priority === "high") return "today"
  if (priority === "normal") return "this_week"
  return "anytime"
}

function mapReplyStatusToStore(
  status: ConsultationReplyPayload["status"],
): ConsultationSessionRecord["status"] {
  if (status === "active") return "open"
  if (status === "waiting_user") return "waiting_user"
  if (status === "waiting_tentacle") return "waiting_tentacle"
  if (status === "resolved") return "resolved"
  return "closed"
}
