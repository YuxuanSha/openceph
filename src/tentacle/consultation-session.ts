/**
 * ConsultationSessionManager — manages multi-turn consultation sessions
 * between tentacles (as "user") and Brain (as "assistant").
 *
 * Each consultation session has its own system prompt derived from
 * CONSULTATION.md template, filled with tentacle info and user memory.
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import * as os from "os"
import * as crypto from "crypto"
import { systemLogger, brainLogger } from "../logger/index.js"
import type { OpenCephConfig } from "../config/config-schema.js"
import type {
  ConsultationRequestPayload,
  ConsultationMessagePayload,
  ConsultationEndPayload,
  ConsultationReplyPayload,
  ConsultationClosePayload,
} from "./contract.js"
import { createIpcMessage } from "./contract.js"
import type { TentacleManager } from "./manager.js"
import type { ConsultationSessionStore, ConsultationSessionRecord } from "./consultation-session-store.js"
import type { SessionStoreManager } from "../session/session-store.js"

// ─── Types ──────────────────────────────────────────────────────

export interface ConsultationContext {
  tentacleId: string
  tentacleDisplayName: string
  tentacleEmoji: string
  tentaclePurpose: string
  tentacleLastActive: string
  memorySummary: string
  userPreferences: string
}

interface ActiveConsultation {
  consultationId: string
  tentacleId: string
  sessionId: string
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
  turn: number
  createdAt: string
  status: "active" | "closed"
  actionsTaken: ConsultationReplyPayload["actions_taken"]
}

export interface ConsultationSessionManagerOptions {
  config: OpenCephConfig
  tentacleManager: TentacleManager
  consultationStore: ConsultationSessionStore
  sessionStore: SessionStoreManager
  deliverToUser?: (channel: string, senderId: string, message: string) => Promise<{ pushId?: string }>
  getMemorySummary?: () => Promise<string>
  getUserPreferences?: () => Promise<string>
  runBrainTurn?: (
    consultationId: string,
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
  ) => Promise<{
    content: string
    toolCalls?: Array<{ name: string; message?: string }>
    pushedItems?: Array<{ message: string; pushId?: string }>
  }>
}

// ─── Manager ────────────────────────────────────────────────────

export class ConsultationSessionManager {
  private activeConsultations: Map<string, ActiveConsultation> = new Map()
  private templateCache: string | null = null

  constructor(private options: ConsultationSessionManagerOptions) {}

  /**
   * Handle a consultation_request from a tentacle.
   * Creates a new consultation session and processes the initial message.
   */
  async handleConsultationRequest(
    tentacleId: string,
    payload: ConsultationRequestPayload,
  ): Promise<ConsultationReplyPayload> {
    const consultationId = crypto.randomUUID()
    const sessionId = consultationId

    // Build consultation context
    const context = await this.buildContext(tentacleId)

    // Load and fill the consultation system prompt template
    const systemPrompt = await this.buildSystemPrompt(context)

    // Create initial message from tentacle
    const initialMessage = payload.initial_message
    if (payload.context) {
      // Append context info
      const ctxStr = Object.entries(payload.context)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")
      // initial_message already contains the formatted report
    }

    const consultation: ActiveConsultation = {
      consultationId,
      tentacleId,
      sessionId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: initialMessage ?? payload.summary ?? "" },
      ],
      turn: 1,
      createdAt: new Date().toISOString(),
      status: "active",
      actionsTaken: [],
    }

    this.activeConsultations.set(consultationId, consultation)

    // Persist to consultation store
    await this.options.consultationStore.upsert({
      sessionId,
      sessionKey: `consultation:${sessionId}`,
      tentacleId,
      mode: payload.mode,
      status: "open",
      requestIds: [consultationId],
      turn: 1,
      purpose: context.tentaclePurpose,
      createdAt: consultation.createdAt,
      updatedAt: consultation.createdAt,
    } as ConsultationSessionRecord)

    // Log to main session for visibility
    await this.logToMainSession(
      tentacleId,
      consultationId,
      `[触手汇报] ${payload.summary ?? ""}`,
      "consultation_request",
    )

    brainLogger.info("consultation_session_created", {
      consultation_id: consultationId,
      tentacle_id: tentacleId,
      mode: payload.mode,
      item_count: payload.item_count,
    })

    // Run Brain's first turn
    const brainResponse = await this.runBrainTurn(consultation)

    return brainResponse
  }

  /**
   * Handle a consultation_message from a tentacle (follow-up in active consultation).
   */
  async handleConsultationMessage(
    tentacleId: string,
    payload: ConsultationMessagePayload,
  ): Promise<void> {
    const consultation = this.activeConsultations.get(payload.consultation_id)
    if (!consultation) {
      brainLogger.warn("consultation_message_orphan", {
        tentacle_id: tentacleId,
        consultation_id: payload.consultation_id,
      })
      return
    }

    // Add tentacle's message as "user"
    consultation.messages.push({ role: "user", content: payload.message })
    consultation.turn++

    // Update store
    await this.options.consultationStore.update(consultation.sessionId, {
      turn: consultation.turn,
      status: "open",
    })

    // Run Brain's next turn
    const reply = await this.runBrainTurn(consultation)

    // Send reply back to tentacle
    await this.options.tentacleManager.sendConsultationReply(tentacleId, reply)
  }

  /**
   * Handle consultation_end from tentacle (tentacle wants to end the session).
   */
  async handleConsultationEnd(
    tentacleId: string,
    payload: ConsultationEndPayload,
  ): Promise<void> {
    const consultation = this.activeConsultations.get(payload.consultation_id)
    if (!consultation) return

    consultation.status = "closed"
    this.activeConsultations.delete(payload.consultation_id)

    // Update store
    await this.options.consultationStore.update(consultation.sessionId, {
      status: "closed",
    })

    brainLogger.info("consultation_session_ended_by_tentacle", {
      consultation_id: payload.consultation_id,
      tentacle_id: tentacleId,
      reason: payload.reason,
      turns: consultation.turn,
    })
  }

  /**
   * Brain-side close of a consultation session.
   */
  async closeConsultation(
    consultationId: string,
    summary: string,
    pushedCount: number,
    discardedCount: number,
    feedback?: string,
  ): Promise<void> {
    const consultation = this.activeConsultations.get(consultationId)
    if (!consultation) return

    const closePayload: ConsultationClosePayload = {
      consultation_id: consultationId,
      summary,
      pushed_count: pushedCount,
      discarded_count: discardedCount,
      feedback,
    }

    // Send close to tentacle
    await this.options.tentacleManager.sendConsultationClose(
      consultation.tentacleId,
      closePayload,
    )

    consultation.status = "closed"
    this.activeConsultations.delete(consultationId)

    // Update store
    await this.options.consultationStore.update(consultation.sessionId, {
      status: "closed",
    })

    brainLogger.info("consultation_session_closed_by_brain", {
      consultation_id: consultationId,
      tentacle_id: consultation.tentacleId,
      turns: consultation.turn,
      pushed_count: pushedCount,
      discarded_count: discardedCount,
    })
  }

  getActiveConsultation(consultationId: string): ActiveConsultation | undefined {
    return this.activeConsultations.get(consultationId)
  }

  getActiveConsultationsForTentacle(tentacleId: string): ActiveConsultation[] {
    return Array.from(this.activeConsultations.values())
      .filter((c) => c.tentacleId === tentacleId && c.status === "active")
  }

  // ─── Internal ─────────────────────────────────────────────────

  private async runBrainTurn(consultation: ActiveConsultation): Promise<ConsultationReplyPayload> {
    let brainContent = ""
    let actionsTaken = [...(consultation.actionsTaken ?? [])]
    let shouldContinue = true

    if (this.options.runBrainTurn) {
      try {
        const result = await this.options.runBrainTurn(
          consultation.consultationId,
          consultation.messages[0].content, // system prompt
          consultation.messages.slice(1),    // user/assistant messages
        )
        brainContent = result.content

        // Process push actions from Brain's run
        // Prefer explicit pushedItems (preferred) then fall back to toolCalls.message
        if (result.pushedItems?.length) {
          for (const item of result.pushedItems) {
            const pushResult = await this.handleSendToUser(consultation, item.message)
            actionsTaken.push({
              action: "pushed_to_user",
              item_ref: item.message.slice(0, 100),
              push_id: pushResult?.pushId,
            })
          }
        } else if (result.toolCalls?.length) {
          for (const tc of result.toolCalls) {
            if (tc.name === "send_to_user" && tc.message) {
              const pushResult = await this.handleSendToUser(consultation, tc.message)
              actionsTaken.push({
                action: "pushed_to_user",
                item_ref: tc.message.slice(0, 100),
                push_id: pushResult?.pushId,
              })
            }
          }
        }
      } catch (err) {
        brainLogger.error("consultation_brain_turn_error", {
          consultation_id: consultation.consultationId,
          error: err instanceof Error ? err.message : String(err),
        })
        brainContent = "处理汇报时出现错误，请稍后重试。"
        shouldContinue = false
      }
    } else {
      // Fallback: auto-acknowledge without LLM
      brainContent = "收到汇报，已记录。"
      shouldContinue = false
    }

    // Add Brain's reply to conversation
    consultation.messages.push({ role: "assistant", content: brainContent })
    consultation.actionsTaken = actionsTaken

    // Determine if conversation should continue
    // Check for explicit end signals in Brain's response
    if (
      brainContent.includes("汇报结束") ||
      brainContent.includes("处理完毕") ||
      consultation.turn >= ((this.options.config.tentacle as any)?.consultation?.maxTurns ?? (this.options.config.session as any)?.consultation?.maxTurns ?? 20)
    ) {
      shouldContinue = false
    }

    const reply: ConsultationReplyPayload = {
      session_id: consultation.sessionId,
      requestId: consultation.consultationId,
      status: shouldContinue ? "active" : "resolved",
      decision: actionsTaken.length > 0 ? "send" : "discard",
      approvedItemIds: [],
      queuedPushCount: actionsTaken.filter(a => a.action === "pushed_to_user").length,
      notes: brainContent,
      consultation_id: consultation.consultationId,
      message: brainContent,
      actions_taken: actionsTaken,
      continue: shouldContinue,
    }

    // NOTE: Do NOT auto-close here. Close is handled by the caller (manager.ts)
    // after it sends consultation_reply. Per protocol: reply first, then close.

    return reply
  }

  private async handleSendToUser(
    consultation: ActiveConsultation,
    message: string,
  ): Promise<{ pushId?: string } | undefined> {
    // Dual-write: log to main session AND deliver to user
    const pushId = crypto.randomUUID()

    // 1. Write to main session JSONL
    await this.logToMainSession(
      consultation.tentacleId,
      consultation.consultationId,
      message,
      "consultation_push",
      pushId,
    )

    // 2. Deliver to user via gateway
    if (this.options.deliverToUser) {
      try {
        const result = await this.options.deliverToUser("last_active", "local", message)
        return { pushId: result?.pushId ?? pushId }
      } catch (err) {
        brainLogger.warn("consultation_push_delivery_failed", {
          consultation_id: consultation.consultationId,
          push_id: pushId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { pushId }
  }

  private async logToMainSession(
    tentacleId: string,
    consultationId: string,
    content: string,
    source: string,
    pushId?: string,
  ): Promise<void> {
    const mainKey = `agent:ceph:${this.options.config.session.mainKey}`
    try {
      await this.options.sessionStore.appendAssistantMessage(
        mainKey,
        content,
        {
          source,
          tentacleId,
          consultationId,
          pushId,
          timestamp: new Date().toISOString(),
        },
      )
    } catch (err) {
      brainLogger.warn("consultation_session_log_failed", {
        consultation_id: consultationId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async buildContext(tentacleId: string): Promise<ConsultationContext> {
    const status = this.options.tentacleManager.getStatus(tentacleId)

    let memorySummary = ""
    if (this.options.getMemorySummary) {
      try {
        memorySummary = await this.options.getMemorySummary()
      } catch {
        memorySummary = "(无法加载用户记忆)"
      }
    }

    let userPreferences = ""
    if (this.options.getUserPreferences) {
      try {
        userPreferences = await this.options.getUserPreferences()
      } catch {
        userPreferences = "(无法加载用户偏好)"
      }
    }

    return {
      tentacleId,
      tentacleDisplayName: status?.purpose ?? tentacleId,
      tentacleEmoji: "🐙",
      tentaclePurpose: status?.purpose ?? "未知",
      tentacleLastActive: status?.lastReportAt ?? status?.updatedAt ?? "未知",
      memorySummary,
      userPreferences,
    }
  }

  private async buildSystemPrompt(context: ConsultationContext): Promise<string> {
    const template = await this.loadTemplate()

    return template
      .replace("{USER_NAME}", "用户")
      .replace("{TENTACLE_DISPLAY_NAME}", context.tentacleDisplayName)
      .replace("{TENTACLE_EMOJI}", context.tentacleEmoji)
      .replace("{TENTACLE_PURPOSE}", context.tentaclePurpose)
      .replace("{TENTACLE_LAST_ACTIVE}", context.tentacleLastActive)
      .replace("{MEMORY_SUMMARY}", context.memorySummary || "(尚无记忆)")
      .replace("{USER_PREFERENCES}", context.userPreferences || "(尚无偏好设置)")
  }

  private async loadTemplate(): Promise<string> {
    if (this.templateCache) return this.templateCache

    const templatePath = path.join(
      this.options.config.agents.defaults.workspace,
      "CONSULTATION.md",
    )

    if (existsSync(templatePath)) {
      try {
        this.templateCache = await fs.readFile(templatePath, "utf-8")
        return this.templateCache
      } catch {
        // Fall through to default
      }
    }

    // Default template
    this.templateCache = DEFAULT_CONSULTATION_TEMPLATE
    return this.templateCache
  }
}

// ─── Default Template ───────────────────────────────────────────

const DEFAULT_CONSULTATION_TEMPLATE = `# Consultation Session — 你在与下属员工对话

## 你的角色
你是 Ceph，{USER_NAME} 的首席 LeaderStaff。你正在听取一位下属员工的工作汇报。

## 当前对话对象
触手：{TENTACLE_DISPLAY_NAME}（{TENTACLE_EMOJI}）
职责：{TENTACLE_PURPOSE}
最近活跃：{TENTACLE_LAST_ACTIVE}

## 用户记忆（你对老板的了解）
{MEMORY_SUMMARY}

## 用户偏好（推送决策参考）
{USER_PREFERENCES}

## 你的职责
1. **理解汇报内容**：认真阅读触手的汇报，理解每条信息的价值
2. **追问细节**：如果信息不够充分，向触手追问（触手有 Agent 能力可以实时查询）
3. **推送决策**：判断哪些信息值得推送给用户
   - 重要且紧急 → 立即调用 send_to_user 推送
   - 重要不紧急 → 放入 morning_digest
   - 不重要 → 不推送，告知触手
4. **推送后反馈**：告诉触手哪些已推送、哪些未推送及原因
5. **质量反馈**：告诉触手未来筛选标准的调整建议

## 推送格式
调用 send_to_user 时，消息应该用你（Ceph）的口吻，不要暴露触手的存在：
- ✅ "发现一篇值得关注的论文：..."
- ❌ "我的触手 t_arxiv_scout 发现了一篇论文..."

## 约束
- 在这个 session 中你不是在和用户对话，是在和下属对话
- 不要使用和用户对话时的语气（不需要"你好"式开场）
- 直接、高效、决策导向
- 推送给用户的消息要精炼，不要把触手的原始数据全部转发
`
