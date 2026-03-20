import type {
  ChannelPlugin, ChannelConfig, DmPolicy, MessageTarget,
  OutboundContent, InboundMessage, AuthSystem, StreamingHandle, TypingHandle,
} from "../channel-plugin.js"
import { extractText, formatAsFeishuText, feishuCardContent } from "./formatter.js"
import { gatewayLogger } from "../../../logger/index.js"

const FEISHU_STREAM_THROTTLE_MS = 2000
const FEISHU_STREAM_PLACEHOLDER = "💭 思考中..."
const FEISHU_START_TIMEOUT_MS = 2000
const FEISHU_MESSAGE_ID_TTL_MS = 24 * 60 * 60 * 1000
const FEISHU_STALE_MESSAGE_GRACE_MS = 15_000
const FEISHU_WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003])
const FEISHU_BACKOFF_CODES = new Set([99991400, 99991403, 429])

type StartupMonitor = {
  settled: boolean
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

export class FeishuChannelPlugin implements ChannelPlugin {
  readonly channelId = "feishu"
  readonly displayName = "飞书 (Feishu)"
  readonly defaultDmPolicy: DmPolicy = "pairing"

  private client: any = null
  private wsClient: any = null
  private config: ChannelConfig | null = null
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null
  /** Dedup: track recently seen message_ids to prevent Feishu SDK retry redelivery */
  private seenMessageIds: Map<string, number> = new Map()
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null
  private startupMonitor: StartupMonitor | null = null
  private sdkLogger: ReturnType<FeishuChannelPlugin["createSdkLogger"]> | null = null
  private startedAt = 0

  async initialize(config: ChannelConfig, _auth: AuthSystem): Promise<void> {
    this.config = config
    const appId = config.appId as string | undefined
    const appSecret = config.appSecret as string | undefined
    const proxyMode = (config.proxyMode as string | undefined) ?? "direct"
    if (!appId || !appSecret) {
      throw new Error("Feishu appId and appSecret required")
    }

    const lark = await import("@larksuiteoapi/node-sdk")
    const axios = await import("axios")
    const domain = (config.domain as string) === "lark" ? lark.Domain.Lark : lark.Domain.Feishu
    const logger = this.createSdkLogger()
    this.sdkLogger = logger

    // Create a custom httpInstance that mirrors the SDK's defaultHttpInstance
    // interceptors. The SDK's internal token management destructures the axios
    // response directly (e.g. `const { tenant_access_token } = await post(...)`)
    // which requires the response interceptor to unwrap `resp.data`.
    // Without this, the TokenManager receives the full AxiosResponse object and
    // destructuring silently yields `undefined`, causing "Missing access token"
    // errors (code 99991661) on every API call.
    const httpInstanceConfig: any = {}
    if (proxyMode === "direct") {
      // When proxyMode is "direct", we explicitly disable the proxy to avoid
      // going through HTTP_PROXY env var. This uses direct HTTPS connection.
      httpInstanceConfig.proxy = false
    }
    // For "inherit" mode (or when proxyMode is not "direct"), axios will use
    // HTTP_PROXY/HTTPS_PROXY environment variables automatically.
    const httpInstance = axios.default.create(httpInstanceConfig)
    httpInstance.interceptors.request.use(
      (req: any) => {
        if (req.headers) {
          req.headers["User-Agent"] = "oapi-node-sdk/1.0.0"
        }
        return req
      },
      undefined,
      { synchronous: true },
    )
    httpInstance.interceptors.response.use(
      (resp: any) => {
        if (resp.config?.["$return_headers"]) {
          return { data: resp.data, headers: resp.headers }
        }
        return resp.data
      },
    )

    this.client = new lark.Client({
      appId,
      appSecret,
      domain,
      httpInstance,
      logger,
      loggerLevel: lark.LoggerLevel.info,
    })

    // Pass a proxy agent to WSClient so the WS connection uses the system proxy.
    // The ws package doesn't auto-read HTTP_PROXY env, so we must inject it manually.
    const proxyUrl =
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy

    let wsAgent: any = undefined
    if (proxyUrl && proxyMode !== "direct") {
      const { HttpsProxyAgent } = await import("https-proxy-agent")
      wsAgent = new HttpsProxyAgent(proxyUrl)
      gatewayLogger.info("feishu_ws_proxy", { proxy: proxyUrl })
    } else if (proxyMode === "direct") {
      gatewayLogger.info("feishu_proxy_bypass", { mode: proxyMode, channel: "feishu" })
    }

    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
      logger,
      loggerLevel: lark.LoggerLevel.info,
      ...(wsAgent ? { agent: wsAgent } : {}),
    })
  }

  async start(): Promise<void> {
    if (!this.wsClient) throw new Error("Feishu client not initialized")
    this.startedAt = Date.now()

    const lark = await import("@larksuiteoapi/node-sdk")
    const self = this
    // Periodically clean up expired dedup entries
    this.dedupCleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, ts] of this.seenMessageIds) {
        if (now - ts > FEISHU_MESSAGE_ID_TTL_MS) {
          this.seenMessageIds.delete(id)
        }
      }
    }, 30_000)

    const eventDispatcher = new lark.EventDispatcher({
      logger: this.sdkLogger ?? this.createSdkLogger(),
      loggerLevel: lark.LoggerLevel.info,
    }).register({
      "im.message.receive_v1": async (data: any) => {
        const messageId = data.message?.message_id
        const messageType = data.message?.message_type
        const senderType =
          data.sender?.sender_type ??
          data.sender?.sender_id?.sender_type ??
          data.message?.sender?.sender_type
        const messageTimestamp = parseInt(data.message?.create_time ?? "0") * 1000

        // Ignore messages sent by the bot/app itself to avoid echo loops.
        if (senderType === "app") {
          gatewayLogger.info("feishu_self_message_ignored", {
            message_id: messageId,
            message_type: messageType,
          })
          return
        }

        // M1 only supports plain text DM input.
        if (messageType && messageType !== "text") {
          gatewayLogger.info("feishu_non_text_ignored", {
            message_id: messageId,
            message_type: messageType,
          })
          return
        }

        // Ignore old events replayed after reconnect/startup.
        if (messageTimestamp > 0 && messageTimestamp < self.startedAt - FEISHU_STALE_MESSAGE_GRACE_MS) {
          gatewayLogger.info("feishu_stale_message_ignored", {
            message_id: messageId,
            message_type: messageType,
            create_time: messageTimestamp,
            started_at: self.startedAt,
          })
          return
        }

        // Dedup: skip if we've already seen this message_id (Feishu SDK retry)
        if (messageId) {
          if (self.seenMessageIds.has(messageId)) {
            gatewayLogger.info("feishu_duplicate_skipped", { message_id: messageId })
            return
          }
          self.seenMessageIds.set(messageId, Date.now())
        }

        const text = extractText(data.message).trim()
        if (!text) {
          gatewayLogger.info("feishu_empty_message_ignored", {
            message_id: messageId,
            message_type: messageType,
          })
          return
        }

        const msg: InboundMessage = {
          channel: "feishu",
          senderId: `feishu:${data.sender?.sender_id?.open_id ?? "unknown"}`,
          sessionKey: "",
          text,
          replyToId: messageId,
          timestamp: messageTimestamp,
          rawPayload: data as any,
        }

        // CRITICAL: Fire-and-forget. Do NOT await the handler.
        // The Feishu WS server will re-send the event if we don't return quickly,
        // because brain processing takes 3-30+ seconds. Returning immediately
        // lets the SDK ack the event to prevent re-delivery.
        void self.messageHandler?.(msg).catch((err: any) => {
          gatewayLogger.error("feishu_handler_error", {
            message_id: messageId,
            error: err.message,
          })
        })
      },
    })

    const startup = this.createStartupMonitor()
    this.startupMonitor = startup
    await this.wsClient.start({ eventDispatcher })

    try {
      await Promise.race([
        startup.promise,
        new Promise<void>((resolve) => setTimeout(resolve, FEISHU_START_TIMEOUT_MS)),
      ])
    } finally {
      this.startupMonitor = null
    }

    // Validate that the SDK can obtain a tenant_access_token by making a
    // lightweight API call. This surfaces auth/network problems at startup
    // rather than silently failing on the first user message.
    try {
      await this.client.auth.tenantAccessToken.internal({
        data: { app_id: (this.config as any)?.appId, app_secret: (this.config as any)?.appSecret },
      })
      gatewayLogger.info("feishu_token_ok", { channel: "feishu" })
    } catch (err: any) {
      gatewayLogger.error("feishu_token_prefetch_failed", {
        channel: "feishu",
        error: err.message,
        hint: "Check app credentials, network, and proxy settings. API calls will fail until this is resolved.",
      })
    }
  }

  async stop(): Promise<void> {
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer)
      this.dedupCleanupTimer = null
    }
    this.seenMessageIds.clear()
    // Feishu SDK doesn't expose a clean stop method
    this.wsClient = null
  }

  private createStartupMonitor(): StartupMonitor {
    let resolve: () => void = () => {}
    let reject: (error: Error) => void = () => {}
    const promise = new Promise<void>((innerResolve, innerReject) => {
      resolve = innerResolve
      reject = innerReject
    })

    return {
      settled: false,
      promise,
      resolve,
      reject,
    }
  }

  private createSdkLogger() {
    const forward = (level: "error" | "warn" | "info" | "debug" | "trace", ...args: any[]) => {
      const entry = this.parseSdkLog(args)
      const meta = entry.meta ? { ...entry.meta } : {}

      if (entry.kind === "ready") {
        gatewayLogger.info("feishu_ws_ready", meta)
        this.resolveStartup()
        return
      }

      if (entry.kind === "error") {
        gatewayLogger.error("feishu_sdk_error", {
          message: entry.message,
          ...meta,
        })
        return
      }

      if (entry.kind === "warn") {
        gatewayLogger.warn("feishu_sdk_warn", {
          message: entry.message,
          ...meta,
        })
        return
      }

      if (level === "debug" || level === "trace") {
        gatewayLogger.debug("feishu_sdk_debug", {
          message: entry.message,
          ...meta,
        })
      }
    }

    return {
      error: (...args: any[]) => forward("error", ...args),
      warn: (...args: any[]) => forward("warn", ...args),
      info: (...args: any[]) => forward("info", ...args),
      debug: (...args: any[]) => forward("debug", ...args),
      trace: (...args: any[]) => forward("trace", ...args),
    }
  }

  private parseSdkLog(args: any[]): {
    kind: "ready" | "error" | "warn" | "debug"
    message: string
    meta?: Record<string, unknown>
  } {
    const values = this.flattenSdkArgs(args)
    const text = values
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" | ")

    if (text.includes("ws client ready")) {
      return { kind: "ready", message: "Feishu websocket connected", meta: { channel: "feishu" } }
    }

    const httpError = values.find((value) =>
      typeof value === "object" &&
      value !== null &&
      ("response" in value || "config" in value || "request" in value || "message" in value),
    ) as Record<string, any> | undefined

    const status = httpError?.response?.status
    const url = httpError?.config?.url ?? httpError?.request?.path
    const proxy = process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy

    if (status === 502) {
      return {
        kind: "error",
        message: proxy
          ? `Feishu API request failed with HTTP 502 via proxy ${proxy}. Check the proxy or direct access to open.feishu.cn.`
          : "Feishu API request failed with HTTP 502. Check network access to open.feishu.cn.",
        meta: { channel: "feishu", status, url },
      }
    }

    if (text.includes("connect failed")) {
      return {
        kind: "error",
        message: "Feishu websocket connection failed. Check app credentials, event subscription mode, and proxy/network settings.",
        meta: { channel: "feishu" },
      }
    }

    if (status && status >= 400) {
      return {
        kind: "error",
        message: `Feishu API request failed with HTTP ${status}. Check app credentials and network settings.`,
        meta: { channel: "feishu", status, url },
      }
    }

    if (text.includes("need to start with a eventDispatcher")) {
      return {
        kind: "warn",
        message: "Feishu websocket missing event dispatcher.",
        meta: { channel: "feishu" },
      }
    }

    return {
      kind: "debug",
      message: text || "Feishu SDK emitted an unstructured log entry",
      meta: { channel: "feishu" },
    }
  }

  private flattenSdkArgs(values: any[]): any[] {
    return values.flatMap((value) => {
      if (Array.isArray(value)) {
        return this.flattenSdkArgs(value)
      }
      return [value]
    })
  }

  private resolveStartup(): void {
    if (!this.startupMonitor || this.startupMonitor.settled) return
    this.startupMonitor.settled = true
    this.startupMonitor.resolve()
  }

  private rejectStartup(error: Error): void {
    if (!this.startupMonitor || this.startupMonitor.settled) return
    this.startupMonitor.settled = true
    this.startupMonitor.reject(error)
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  async send(target: MessageTarget, content: OutboundContent): Promise<void> {
    if (!this.client) return
    const chunkLimit = (this.config as any)?.textChunkLimit ?? 2000
    const resolvedTarget = this.resolveSendTarget(target)
    let lastError: Error | null = null

    for (const chunk of chunkText(content.text, chunkLimit)) {
      try {
        gatewayLogger.info("feishu_send_attempt", {
          receive_id: resolvedTarget.receiveId,
          receive_id_type: resolvedTarget.receiveIdType,
          reply_to_id: target.replyToId,
        })
        const result = await this.sendReplyOrDirect({
          target,
          msgType: "text",
          content: formatAsFeishuText(chunk).content,
        })
        gatewayLogger.info("feishu_send_success", { result })
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err))
        gatewayLogger.error("feishu_send_error", { error: err.message, status: err.response?.status, data: err.response?.data })
        break
      }
    }

    if (lastError) {
      throw lastError
    }
  }

  async beginTyping(msg: InboundMessage): Promise<TypingHandle> {
    if (!this.client) return { stop: async () => {} }
    if ((this.config as any)?.typingIndicator === false) return { stop: async () => {} }
    if (!msg.replyToId) return { stop: async () => {} }

    const emoji = (this.config as any)?.typingEmoji ?? "Typing"
    const keepaliveMs = Math.max(500, Number((this.config as any)?.typingKeepaliveMs ?? 3000))
    const reactionIds = new Set<string>()
    let stopped = false
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null

    const addTypingIndicator = async (phase: "start" | "keepalive") => {
      if (reactionIds.size > 0) {
        return
      }

      try {
        const result = await this.client.im.messageReaction.create({
          path: { message_id: msg.replyToId },
          data: {
            reaction_type: {
              emoji_type: emoji,
            },
          },
        })
        const reactionId = result?.data?.reaction_id
        if (reactionId) reactionIds.add(reactionId)
        gatewayLogger.info(phase === "start" ? "feishu_typing_start" : "feishu_typing_keepalive", {
          message_id: msg.replyToId,
          reaction_id: reactionId,
          emoji,
          keepalive_ms: keepaliveMs,
        })
      } catch (err: any) {
        if (isFeishuBackoffError(err)) {
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer)
            keepaliveTimer = null
          }
        }
        gatewayLogger.warn(phase === "start" ? "feishu_typing_start_error" : "feishu_typing_keepalive_error", {
          error: err.message,
          message_id: msg.replyToId,
          emoji,
        })
      }
    }

    await addTypingIndicator("start")

    keepaliveTimer = setInterval(() => {
      if (stopped) return
      void addTypingIndicator("keepalive")
    }, keepaliveMs)

    return {
      stop: async () => {
        if (stopped) return
        stopped = true
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer)
          keepaliveTimer = null
        }

        for (const reactionId of reactionIds) {
          try {
            await this.client.im.messageReaction.delete({
              path: {
                message_id: msg.replyToId!,
                reaction_id: reactionId,
              },
            })
            gatewayLogger.info("feishu_typing_stop", {
              message_id: msg.replyToId,
              reaction_id: reactionId,
              emoji,
            })
          } catch (err: any) {
            gatewayLogger.warn("feishu_typing_stop_error", {
              error: err.message,
              message_id: msg.replyToId,
              reaction_id: reactionId,
              emoji,
            })
          }
        }
      },
    }
  }

  async beginStreaming(target: MessageTarget): Promise<StreamingHandle> {
    if (!this.client) throw new Error("Feishu client not initialized")
    const resolvedTarget = this.resolveSendTarget(target)
    const sendReplyOrDirect = this.sendReplyOrDirect.bind(this)

    // Send initial placeholder card. Prefer reply semantics so the visible UX
    // stays anchored to the inbound message, but fall back to a direct send if
    // the reply target was withdrawn or is no longer available.
    let streamMsgId: string | null = null
    try {
      const initResult = await this.sendReplyOrDirect({
        target,
        msgType: "interactive",
        content: feishuCardContent(FEISHU_STREAM_PLACEHOLDER),
      })
      streamMsgId = initResult?.data?.message_id ?? null
      gatewayLogger.info("feishu_stream_init", {
        message_id: streamMsgId,
        receive_id: resolvedTarget.receiveId,
        receive_id_type: resolvedTarget.receiveIdType,
        reply_to_id: target.replyToId,
      })
    } catch (err: any) {
      gatewayLogger.error("feishu_stream_init_error", { error: err.message })
    }

    let lastUpdate = 0
    let pendingText = ""
    let updateTimer: ReturnType<typeof setTimeout> | null = null
    let patchInFlight = false
    const client = this.client

    const doPatch = async (text: string) => {
      if (!streamMsgId || patchInFlight) return
      patchInFlight = true
      try {
        await client.im.message.patch({
          path: { message_id: streamMsgId },
          data: {
            content: feishuCardContent(text),
          },
        })
        lastUpdate = Date.now()
      } catch (err: any) {
        gatewayLogger.warn("feishu_patch_error", { error: err.message })
      } finally {
        patchInFlight = false
      }
    }

    return {
      async update(accumulated: string) {
        pendingText = accumulated
        if (patchInFlight) return // skip while a patch is in-flight
        const elapsed = Date.now() - lastUpdate
        if (elapsed >= FEISHU_STREAM_THROTTLE_MS) {
          if (updateTimer) { clearTimeout(updateTimer); updateTimer = null }
          await doPatch(accumulated)
        } else if (!updateTimer) {
          updateTimer = setTimeout(async () => {
            updateTimer = null
            if (!patchInFlight) await doPatch(pendingText)
          }, FEISHU_STREAM_THROTTLE_MS - elapsed)
        }
      },
      async finalize(text: string) {
        if (updateTimer) { clearTimeout(updateTimer); updateTimer = null }
        if (!text) return
        if (streamMsgId) {
          await doPatch(text)
        } else {
          // Fallback: initial card send failed, send as plain text
          try {
            await sendReplyOrDirect({
              target,
              msgType: "text",
              content: JSON.stringify({ text }),
            })
          } catch (err: any) {
            gatewayLogger.error("feishu_fallback_send_error", { error: err.message })
          }
        }
      },
    }
  }

  validateSender(senderId: string, policy: DmPolicy, allowFrom: string[]): boolean {
    if (policy === "open") return true
    if (policy === "disabled") return false
    if (policy === "allowlist") return allowFrom.includes(senderId)
    return false
  }

  private resolveSendTarget(target: MessageTarget): {
    receiveId: string
    receiveIdType: "chat_id" | "open_id"
  } {
    const chatId = typeof target.chatId === "string" ? target.chatId.trim() : ""
    if (chatId) {
      return { receiveId: chatId, receiveIdType: "chat_id" }
    }

    const recipientId = typeof target.recipientId === "string" ? target.recipientId : target.senderId
    return {
      receiveId: recipientId.replace("feishu:", ""),
      receiveIdType: "open_id",
    }
  }

  private async sendReplyOrDirect(params: {
    target: MessageTarget
    msgType: "text" | "interactive"
    content: string
  }): Promise<any> {
    const resolvedTarget = this.resolveSendTarget(params.target)
    const replyToId = params.target.replyToId?.trim()

    if (replyToId) {
      try {
        const response = await this.client.im.message.reply({
          path: { message_id: replyToId },
          data: {
            content: params.content,
            msg_type: params.msgType,
          },
        })

        if (!shouldFallbackFromReplyTarget(response)) {
          return response
        }

        gatewayLogger.warn("feishu_reply_fallback", {
          reply_to_id: replyToId,
          code: response?.code,
          msg: response?.msg,
        })
      } catch (err: any) {
        if (!isWithdrawnReplyError(err)) {
          throw err
        }

        gatewayLogger.warn("feishu_reply_target_unavailable", {
          reply_to_id: replyToId,
          error: err.message,
        })
      }
    }

    return await this.client.im.message.create({
      data: {
        receive_id: resolvedTarget.receiveId,
        msg_type: params.msgType,
        content: params.content,
      },
      params: { receive_id_type: resolvedTarget.receiveIdType },
    })
  }
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit)
    if (splitAt < limit / 2) splitAt = remaining.lastIndexOf(" ", limit)
    if (splitAt < limit / 2) splitAt = limit
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function isFeishuBackoffError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false
  }

  const response = (err as { response?: { status?: number; data?: { code?: number } } }).response
  if (response?.status === 429) {
    return true
  }
  if (typeof response?.data?.code === "number" && FEISHU_BACKOFF_CODES.has(response.data.code)) {
    return true
  }

  const code = (err as { code?: number }).code
  return typeof code === "number" && FEISHU_BACKOFF_CODES.has(code)
}

function shouldFallbackFromReplyTarget(response: { code?: number; msg?: string }): boolean {
  if (response.code !== undefined && FEISHU_WITHDRAWN_REPLY_ERROR_CODES.has(response.code)) {
    return true
  }

  const msg = response.msg?.toLowerCase() ?? ""
  return msg.includes("withdrawn") || msg.includes("not found")
}

function isWithdrawnReplyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false
  }

  const code = (err as { code?: number }).code
  if (typeof code === "number" && FEISHU_WITHDRAWN_REPLY_ERROR_CODES.has(code)) {
    return true
  }

  const response = (err as { response?: { data?: { code?: number; msg?: string } } }).response
  return typeof response?.data?.code === "number" &&
    FEISHU_WITHDRAWN_REPLY_ERROR_CODES.has(response.data.code)
}
