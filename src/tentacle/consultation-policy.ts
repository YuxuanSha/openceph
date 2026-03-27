import type { ConsultationReplyPayload, ConsultationRequestPayload } from "./contract.js"
import type { ConsultationSessionRecord, ConsultationTrackedItem } from "./consultation-session-store.js"

export interface TentacleConsultationMetadata {
  purpose?: string
  brief?: string
}

export interface ConsultationResetPolicy {
  maxTurns: number
  maxAgeMinutes: number
  carryPendingOnReset: boolean
}

export interface ConsultationDecisionPlan {
  decision: "send" | "discard" | "defer" | "question"
  status: "active" | "waiting_user" | "waiting_tentacle" | "resolved" | "closed"
  nextAction: "await_user" | "await_tentacle" | "none"
  questions?: string[]
  notes: string
  approvedItems: ConsultationTrackedItem[]
  pendingItems: ConsultationTrackedItem[]
  discardedItems: ConsultationTrackedItem[]
}

export function getDefaultConsultationResetPolicy(
  overrides?: Partial<ConsultationResetPolicy>,
): ConsultationResetPolicy {
  return {
    maxTurns: overrides?.maxTurns ?? 20,
    maxAgeMinutes: overrides?.maxAgeMinutes ?? 30,
    carryPendingOnReset: overrides?.carryPendingOnReset ?? true,
  }
}

export function evaluateConsultationReset(
  session: ConsultationSessionRecord,
  policy: ConsultationResetPolicy,
  nowIso: string = new Date().toISOString(),
): { shouldReset: boolean; reason?: "max_turns" | "max_age" } {
  if (session.turn >= policy.maxTurns) {
    return { shouldReset: true, reason: "max_turns" }
  }

  const ageMs = new Date(nowIso).getTime() - new Date(session.createdAt).getTime()
  const maxAgeMs = policy.maxAgeMinutes * 60 * 1000
  if (ageMs >= maxAgeMs) {
    return { shouldReset: true, reason: "max_age" }
  }

  return { shouldReset: false }
}

export function planConsultationDecision(
  payload: ConsultationRequestPayload,
  sessionId: string,
  metadata?: TentacleConsultationMetadata,
  nowIso: string = new Date().toISOString(),
): ConsultationDecisionPlan {
  // Per spec, consultation_request carries initial_message as a natural-language report.
  // The Brain processes this via LLM, not item-by-item. Default plan: approve for delivery.
  const item = toTrackedItem({
    itemId: `${sessionId}:report`,
    requestId: sessionId,
    content: payload.initial_message ?? payload.summary ?? "",
    reason: payload.summary,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: "pending",
    sessionId,
  })

  return {
    decision: "send",
    status: "resolved",
    nextAction: "none",
    notes: `Received consultation with ${payload.item_count} item(s). Processing via Brain LLM.`,
    approvedItems: [item],
    pendingItems: [],
    discardedItems: [],
  }
}

function shouldAllowReferencePush(metadata?: TentacleConsultationMetadata): boolean {
  const combined = `${metadata?.brief ?? ""}\n${metadata?.purpose ?? ""}`.toLowerCase()
  if (!combined.trim()) return false
  return /(直通|直接推送|direct push|directly push|例行告知|status|heartbeat|digest|摘要|汇总|每.?分钟.*告知|daily digest)/.test(combined)
}

function toTrackedItem(item: ConsultationTrackedItem): ConsultationTrackedItem {
  return { ...item }
}
