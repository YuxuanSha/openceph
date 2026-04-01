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
import { loadIdentityFiles } from "../brain/context-assembler.js"
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
  clientRequestId: string  // original request_id from the tentacle's consultation_request
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
    tentacleId: string,
  ) => Promise<{
    content: string
    toolCalls?: Array<{ name: string; message?: string }>
    pushedItems?: Array<{ message: string; pushId?: string }>
  }>
  onConsultationClosed?: (tentacleId: string, consultation: {
    consultationId: string
    turns: number
    pushedCount: number
    discardedCount: number
    summary: string
  }) => Promise<void>
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
      clientRequestId: payload.request_id,
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

    // NOTE: Do NOT log to main session here — consultation content stays in its
    // own isolated session. Only send_to_user pushes get dual-written to main session.
    // This prevents context pollution and premature compaction.

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

    // If Brain says conversation is done, close the session
    if (reply.continue === false) {
      const pushedCount = reply.actions_taken?.filter((a: any) => a.action === "pushed_to_user").length ?? reply.queuedPushCount ?? 0
      await this.closeConsultation(
        payload.consultation_id,
        reply.notes ?? reply.message ?? "",
        pushedCount,
        Math.max(0, (consultation.turn) - pushedCount),
      )
    }
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
      client_request_id: consultation.clientRequestId,
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

    // Notify manager to archive and update counters
    if (this.options.onConsultationClosed) {
      await this.options.onConsultationClosed(consultation.tentacleId, {
        consultationId,
        turns: consultation.turn,
        pushedCount,
        discardedCount,
        summary,
      })
    }
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
          consultation.tentacleId,
        )
        brainContent = result.content

        // Track push actions from Brain's run.
        // NOTE: send_to_user already executed within runIsolatedTurn — it handled
        // delivery to user AND dual-write to main session. We only record metadata
        // here for actionsTaken tracking. Do NOT re-deliver or re-write.
        if (result.pushedItems?.length) {
          for (const item of result.pushedItems) {
            actionsTaken.push({
              action: "pushed_to_user",
              item_ref: item.message.slice(0, 100),
              push_id: item.pushId,
            })
          }
        } else if (result.toolCalls?.length) {
          for (const tc of result.toolCalls) {
            if (tc.name === "send_to_user") {
              actionsTaken.push({
                action: "pushed_to_user",
                item_ref: (tc as any).message?.slice(0, 100) ?? "(via tool)",
              })
            }
          }
        }
      } catch (err) {
        brainLogger.error("consultation_brain_turn_error", {
          consultation_id: consultation.consultationId,
          error: err instanceof Error ? err.message : String(err),
        })
        brainContent = "An error occurred while processing the report. Please try again later."
        shouldContinue = false
      }
    } else {
      // Fallback: auto-acknowledge without LLM
      brainContent = "Report received and recorded."
      shouldContinue = false
    }

    // Add Brain's reply to conversation
    consultation.messages.push({ role: "assistant", content: brainContent })
    consultation.actionsTaken = actionsTaken

    // Determine if conversation should continue.
    // Consultation is for quick review+push, not deep research. Max 3 turns.
    const maxTurns = (this.options.config.tentacle as any)?.consultation?.maxTurns
      ?? (this.options.config.session as any)?.consultation?.maxTurns
      ?? 3
    const hasPushedSomething = actionsTaken.some(a => a.action === "pushed_to_user")

    if (consultation.turn >= maxTurns) {
      shouldContinue = false
    } else if (hasPushedSomething) {
      // Brain already pushed content — default to done unless explicit follow-up
      const hasFollowUpSignal = (
        brainContent.includes("help me check") ||
        brainContent.includes("look into") ||
        brainContent.includes("add more details")
      )
      shouldContinue = hasFollowUpSignal
    } else {
      // No pushes yet — check if Brain is asking tentacle for more info
      const hasFollowUpSignal = (
        brainContent.includes("help me check") ||
        brainContent.includes("look into") ||
        brainContent.includes("could you") ||
        brainContent.includes("elaborate") ||
        brainContent.includes("add more details") ||
        brainContent.includes("specifics")
      )
      const hasEndSignal = (
        brainContent.includes("no push") ||
        brainContent.includes("report complete") ||
        brainContent.includes("processing done") ||
        brainContent.includes("end conversation") ||
        brainContent.includes("nothing to push") ||
        brainContent.includes("continue: false")
      )

      if (hasEndSignal) {
        shouldContinue = false
      } else if (hasFollowUpSignal) {
        shouldContinue = true
      } else {
        // No explicit follow-up, no end signal → default done
        shouldContinue = false
      }
    }

    // If Brain made no tool calls and no explicit decision on turn 1,
    // give it one more chance with a mandatory nudge.
    if (!shouldContinue && actionsTaken.length === 0 && consultation.turn === 1) {
      consultation.messages.push({
        role: "user",
        content: "[SYSTEM MANDATORY] You must make a decision now: call send_to_user to push content worth sharing, or reply with \"no push\" and explain why. No other form of reply is accepted.",
      })
      shouldContinue = true
      brainLogger.info("consultation_retry_nudge", {
        consultation_id: consultation.consultationId,
        reason: "no_tool_calls_on_turn_1",
      })
    }

    // After nudge, if turn 2 still no push and no explicit question → force close
    if (!shouldContinue && actionsTaken.length === 0 && consultation.turn === 2) {
      brainLogger.warn("consultation_force_close", {
        consultation_id: consultation.consultationId,
        reason: "no_push_after_nudge",
      })
      shouldContinue = false
    }

    // Determine decision: "send" if items were pushed, "defer" if conversation
    // is still active (Brain might push in a later turn), "discard" only when
    // conversation ends with no pushes.
    const hasPushes = actionsTaken.some(a => a.action === "pushed_to_user")
    let decision: "send" | "discard" | "defer" | "question"
    if (hasPushes) {
      decision = "send"
    } else if (shouldContinue) {
      decision = "defer"
    } else {
      decision = "discard"
    }

    const reply: ConsultationReplyPayload = {
      session_id: consultation.sessionId,
      requestId: consultation.consultationId,
      status: shouldContinue ? "active" : "resolved",
      decision,
      approvedItemIds: [],
      queuedPushCount: actionsTaken.filter(a => a.action === "pushed_to_user").length,
      notes: brainContent,
      consultation_id: consultation.consultationId,
      client_request_id: consultation.clientRequestId,
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
        memorySummary = "(failed to load user memory)"
      }
    }

    let userPreferences = ""
    if (this.options.getUserPreferences) {
      try {
        userPreferences = await this.options.getUserPreferences()
      } catch {
        userPreferences = "(failed to load user preferences)"
      }
    }

    return {
      tentacleId,
      tentacleDisplayName: status?.purpose ?? tentacleId,
      tentacleEmoji: "🐙",
      tentaclePurpose: status?.purpose ?? "unknown",
      tentacleLastActive: status?.lastReportAt ?? status?.updatedAt ?? "unknown",
      memorySummary,
      userPreferences,
    }
  }

  private async buildSystemPrompt(context: ConsultationContext): Promise<string> {
    const workspace = this.options.config.agents.defaults.workspace

    // Load identity files from brain-consultation scene (with fallback to root)
    const identityFiles = await loadIdentityFiles(
      workspace, "brain-consultation",
      ["SOUL.md", "AGENTS.md", "TOOLS.md", "IDENTITY.md"],
    )

    // Load the consultation template (CONSULTATION.md) which has placeholders
    const template = await this.loadTemplate()
    const filled = template
      .replace("{USER_NAME}", "User")
      .replace("{TENTACLE_DISPLAY_NAME}", context.tentacleDisplayName)
      .replace("{TENTACLE_EMOJI}", context.tentacleEmoji)
      .replace("{TENTACLE_PURPOSE}", context.tentaclePurpose)
      .replace("{TENTACLE_LAST_ACTIVE}", context.tentacleLastActive)
      .replace("{MEMORY_SUMMARY}", context.memorySummary || "(no memory yet)")
      .replace("{USER_PREFERENCES}", context.userPreferences || "(no preferences set)")

    // Assemble: consultation template + identity files + reminder
    const parts = [filled]
    for (const f of identityFiles) {
      parts.push(`# [Identity] ${f.name}\n${f.content}`)
    }
    const reminder = "# REMINDER: You MUST use the send_to_user tool to push content to the user. Writing text analysis alone is not a push — the user cannot see your text replies."
    parts.push(reminder)
    return parts.join("\n\n---\n\n")
  }

  private async loadTemplate(): Promise<string> {
    if (this.templateCache) return this.templateCache

    const templatePath = path.join(
      this.options.config.agents.defaults.workspace,
      "identities", "brain-consultation", "CONSULTATION.md",
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

const DEFAULT_CONSULTATION_TEMPLATE = `# Consultation Session — You are speaking with a subordinate staff member

## Your Role
You are Ceph, {USER_NAME}'s chief LeaderStaff. You are receiving a work report from a subordinate staff member.

## Current Conversation Partner
Tentacle: {TENTACLE_DISPLAY_NAME} ({TENTACLE_EMOJI})
Responsibility: {TENTACLE_PURPOSE}
Last Active: {TENTACLE_LAST_ACTIVE}

## User Memory (what you know about your boss)
{MEMORY_SUMMARY}

## User Preferences (reference for push decisions)
{USER_PREFERENCES}

## Your Responsibilities
1. **Understand the report**: Read the tentacle's report carefully and understand the value of each piece of information
2. **Ask for details**: If information is insufficient, ask the tentacle for more (tentacles have Agent capabilities and can query in real time)
3. **Push decisions**: Determine which information is worth pushing to the user. The tentacle has already done initial filtering; the default tendency is to push.
   - Directly related to the user's current work/interests → push
   - High score, many comments, engineering value → push
   - Completely unrelated to the user → do not push, inform the tentacle
   - Uncertain → ask the tentacle for more information before deciding
4. **Post-push feedback**: Tell the tentacle what was pushed, what was not, and why
5. **Quality feedback**: Give the tentacle suggestions for adjusting future filtering criteria

## Conversation Turns
This is a multi-turn conversation with a maximum of 20 turns. After you reply, the tentacle will receive your message and can respond.
- Asked a follow-up question → continue: true, wait for tentacle's answer
- Finished processing all content → continue: false, conversation ends

## Push Format
When calling send_to_user, the message should be in your (Ceph's) voice — do not expose the tentacle's existence:
- ✅ "Found a paper worth reading: ..."
- ❌ "My tentacle t_arxiv_scout found a paper..."

## Constraints
- In this session you are not talking to the user, you are talking to a subordinate
- Do not use the tone you use when talking to the user (no "Hello" style openers)
- Direct, efficient, decision-oriented
- Keep messages pushed to the user concise — do not forward all of the tentacle's raw data
`
