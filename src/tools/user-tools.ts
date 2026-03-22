import type { MessageTarget, OutboundContent } from "../gateway/adapters/channel-plugin.js"
import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import { brainLogger, gatewayLogger } from "../logger/index.js"
import type { ToolRegistryEntry } from "./index.js"
import type { SessionStoreManager } from "../session/session-store.js"
import type { OpenCephConfig } from "../config/config-schema.js"
import * as os from "os"
import * as crypto from "crypto"
import * as path from "path"
import { OutboundQueue } from "../push/outbound-queue.js"

export interface GatewayDeliveryFn {
  (target: MessageTarget, content: OutboundContent): Promise<void>
}

export interface SendToUserToolParams {
  message: string
  timing: "immediate" | "best_time" | "morning_digest"
  channel?: "telegram" | "feishu" | "webchat" | "last_active"
  priority?: "urgent" | "normal" | "low"
  source_tentacles?: string[]
}

export interface SendToUserRuntimeOptions {
  currentSessionKey: string
  mainSessionKey: string
  deliverToUser?: GatewayDeliveryFn
  lastActiveChannel: () => string
  lastActiveSenderId: () => string
  sessionStore?: SessionStoreManager
  queuePath?: string
  onConsultationPush?: (payload: {
    pushId: string
    sessionKey: string
    targetSessionKey: string
    channel: string
    senderId: string
    timing: SendToUserToolParams["timing"]
    priority: NonNullable<SendToUserToolParams["priority"]>
    message: string
    tentacleId?: string
    delivered: boolean
  }) => Promise<void> | void
}

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details }
}

function resolveChannel(
  requested: SendToUserToolParams["channel"],
  getLastActiveChannel: () => string,
): string {
  if (!requested || requested === "last_active") {
    return getLastActiveChannel() || "cli"
  }
  return requested
}

function isMainSession(sessionKey: string, mainSessionKey: string): boolean {
  return sessionKey === mainSessionKey || sessionKey.startsWith(`${mainSessionKey}:`)
}

function isConsultationSession(sessionKey: string): boolean {
  return sessionKey.startsWith("consultation:") || sessionKey.startsWith("cron:")
}

export async function executeSendToUser(
  params: SendToUserToolParams,
  runtime: SendToUserRuntimeOptions,
) {
  const channel = resolveChannel(params.channel, runtime.lastActiveChannel)
  const senderId = runtime.lastActiveSenderId() || "local"
  const priority = params.priority ?? "normal"
  const queuePath = runtime.queuePath ?? path.join(os.homedir(), ".openceph", "state", "outbound-queue.json")
  const outboundQueue = new OutboundQueue(queuePath)

  if (isMainSession(runtime.currentSessionKey, runtime.mainSessionKey)) {
    if (params.timing === "immediate" && runtime.deliverToUser) {
      const messageId = crypto.randomUUID()
      await runtime.deliverToUser(
        { channel, senderId },
        { text: params.message, timing: "immediate", priority, messageId },
      )
      brainLogger.info("send_to_user", {
        session_id: runtime.currentSessionKey,
        source: "main_session",
        timing: "immediate",
        channel,
        priority,
        message_id: messageId,
      })
      return ok(`已发送（immediate）`, {
        delivered: true,
        source: "main_session",
        channel,
        timing: "immediate",
        messageId,
      })
    }

    const queuedId = crypto.randomUUID()
    await outboundQueue.addDeferredMessage({
      messageId: queuedId,
      message: params.message,
      channel,
      senderId,
      timing: params.timing === "immediate" ? "best_time" : params.timing,
      priority,
      source: "main_session",
    })
    brainLogger.info("send_to_user_queued", {
      session_id: runtime.currentSessionKey,
      source: "main_session",
      timing: params.timing,
      channel,
      priority,
      message_id: queuedId,
    })
    return ok(`已加入发送队列（${params.timing}）`, {
      queued: true,
      source: "main_session",
      channel,
      timing: params.timing,
      messageId: queuedId,
    })
  }

  if (isConsultationSession(runtime.currentSessionKey)) {
    const pushId = `p-${crypto.randomUUID()}`
    const tentacleId = params.source_tentacles?.[0]

    let delivered = false
    if (params.timing === "immediate" && runtime.deliverToUser) {
      await runtime.sessionStore?.appendAssistantMessage(
        runtime.mainSessionKey,
        params.message,
        {
          source: "tentacle_push",
          tentacleId: tentacleId ?? "unknown",
          pushId,
          consultationSessionId: runtime.currentSessionKey,
          pushedAt: new Date().toISOString(),
        },
      )

      brainLogger.info("push_to_main_session", {
        session_id: runtime.currentSessionKey,
        target_session: runtime.mainSessionKey,
        push_id: pushId,
        tentacle_id: tentacleId,
        channel,
        timing: params.timing,
        priority,
      })

      await runtime.deliverToUser(
        { channel, senderId },
        { text: params.message, timing: "immediate", priority, messageId: pushId },
      )
      delivered = true
      gatewayLogger.info("push_delivered_from_consultation", {
        push_id: pushId,
        tentacle_id: tentacleId,
        channel,
      })
    } else {
      await outboundQueue.addDeferredMessage({
        messageId: pushId,
        message: params.message,
        channel,
        senderId,
        timing: params.timing === "immediate" ? "best_time" : params.timing,
        priority,
        source: "consultation_session",
        sourceSessionKey: runtime.currentSessionKey,
        targetSessionKey: runtime.mainSessionKey,
        tentacleId,
      })
      brainLogger.info("send_to_user_queued", {
        session_id: runtime.currentSessionKey,
        target_session: runtime.mainSessionKey,
        source: "consultation_session",
        timing: params.timing,
        channel,
        priority,
        push_id: pushId,
        tentacle_id: tentacleId,
      })
    }

    if (delivered) {
      await runtime.onConsultationPush?.({
        pushId,
        sessionKey: runtime.currentSessionKey,
        targetSessionKey: runtime.mainSessionKey,
        channel,
        senderId,
        timing: params.timing,
        priority,
        message: params.message,
        tentacleId,
        delivered,
      })
    }

    brainLogger.info("send_to_user", {
      session_id: runtime.currentSessionKey,
      target_session: runtime.mainSessionKey,
      source: "consultation_session",
      timing: params.timing,
      channel,
      priority,
      push_id: pushId,
      tentacle_id: tentacleId,
    })

    return ok(
      `已推送到用户主 session（pushId: ${pushId}，channel: ${channel}）`,
      {
        delivered,
        channel,
        timing: params.timing,
        priority,
        pushId,
        targetSession: runtime.mainSessionKey,
      },
    )
  }

  if (params.timing === "immediate" && runtime.deliverToUser) {
    const messageId = crypto.randomUUID()
    await runtime.deliverToUser(
      { channel, senderId },
      { text: params.message, timing: "immediate", priority, messageId },
    )
    return ok("已发送", { delivered: true, channel, timing: "immediate", messageId })
  }

  const queuedId = crypto.randomUUID()
  await outboundQueue.addDeferredMessage({
    messageId: queuedId,
    message: params.message,
    channel,
    senderId,
    timing: params.timing === "immediate" ? "best_time" : params.timing,
    priority,
    source: "main_session",
  })
  return ok("已加入发送队列", { queued: true, channel, timing: params.timing, messageId: queuedId })
}

export function createUserTools(opts: {
  config?: OpenCephConfig
  sessionStore?: SessionStoreManager
  deliverToUser?: GatewayDeliveryFn
  lastActiveChannel?: () => string
  lastActiveSenderId?: () => string
  queuePath?: string
  resolveSessionKey?: (sessionFile: string) => Promise<string | undefined>
  onConsultationPush?: SendToUserRuntimeOptions["onConsultationPush"]
}): ToolRegistryEntry[] {
  const sendToUser: ToolDefinition = {
    name: "send_to_user",
    label: "Send to User",
    description: "向用户发送主动消息。系统中唯一允许触达用户的出口。",
    promptSnippet: "send_to_user — 仅用于异步通知或主动外呼；正常对话直接回复文本，不要调用此工具",
    parameters: Type.Object({
      message: Type.String({ description: "发送给用户的完整消息内容" }),
      timing: Type.Union([
        Type.Literal("immediate"),
        Type.Literal("best_time"),
        Type.Literal("morning_digest"),
      ]),
      channel: Type.Optional(Type.Union([
        Type.Literal("telegram"),
        Type.Literal("feishu"),
        Type.Literal("webchat"),
        Type.Literal("last_active"),
      ])),
      priority: Type.Optional(Type.Union([
        Type.Literal("urgent"),
        Type.Literal("normal"),
        Type.Literal("low"),
      ])),
      source_tentacles: Type.Optional(Type.Array(Type.String(), {
        description: "推送来源的触手 ID 列表（consultation session 中使用）",
      })),
    }),
    async execute(_id, params: SendToUserToolParams, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile()
      const currentSessionKey = sessionFile
        ? await opts.resolveSessionKey?.(sessionFile) ?? (opts.sessionStore
          ? await opts.sessionStore.resolveSessionKeyByTranscriptPath(sessionFile)
          : undefined) ?? (opts.config
            ? `agent:ceph:${opts.config.session.mainKey}`
            : "agent:ceph:main")
        : (opts.config ? `agent:ceph:${opts.config.session.mainKey}` : "agent:ceph:main")

      try {
        return await executeSendToUser(params, {
          currentSessionKey,
          mainSessionKey: opts.config ? `agent:ceph:${opts.config.session.mainKey}` : "agent:ceph:main",
          deliverToUser: opts.deliverToUser,
          lastActiveChannel: opts.lastActiveChannel ?? (() => "cli"),
          lastActiveSenderId: opts.lastActiveSenderId ?? (() => "local"),
          sessionStore: opts.sessionStore,
          queuePath: opts.queuePath,
          onConsultationPush: opts.onConsultationPush,
        })
      } catch (err: any) {
        brainLogger.error("send_to_user_failed", {
          session_id: currentSessionKey,
          error: err.message,
        })
        return ok(`Error delivering message: ${err.message}`)
      }
    },
  }

  return [
    { name: "send_to_user", description: sendToUser.description, group: "messaging", tool: sendToUser },
  ]
}
