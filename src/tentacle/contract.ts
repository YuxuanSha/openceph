/**
 * OpenCeph IPC Contract
 *
 * Defines all message types and payloads for tentacle ↔ Brain IPC.
 * Uses JSON-line format (one JSON object per line).
 *
 * NOTE: This file contains BOTH classic IPC types (for backward compatibility
 * with existing infrastructure) AND newer protocol types (for the
 * skill-tentacle protocol spec).
 */

export type IpcMessageType =
  | "tentacle_register"
  | "report_finding"
  | "consultation_request"
  | "consultation_reply"
  | "consultation_done"
  | "consultation_message"
  | "consultation_end"
  | "consultation_close"
  | "directive"
  | "heartbeat_trigger"
  | "heartbeat_result"
  | "heartbeat_ping"
  | "heartbeat_ack"
  | "tool_request"
  | "tool_result"
  | "status_update"

export interface IpcMessage {
  type: IpcMessageType
  sender?: string
  receiver?: string
  tentacle_id?: string
  payload: unknown
  timestamp: string
  message_id: string
}

export function createIpcMessage(
  type: IpcMessageType,
  tentacleId: string,
  payload: unknown,
): IpcMessage {
  return {
    type,
    sender: "brain",
    receiver: tentacleId,
    tentacle_id: tentacleId,
    payload,
    timestamp: new Date().toISOString(),
    message_id: crypto.randomUUID(),
  }
}

// ─── Shared Enums ───────────────────────────────────────────────

/** Classic consultation mode values (kept for backward compatibility). */
export type LegacyConsultationMode = "single" | "batch" | "action_confirm"

/** New protocol mode values. */
export type ConsultationMode = "batch" | "eager" | "passive"

/** Per spec §4.1 — actions_taken[].action in consultation_reply. */
export type ConsultationAction = "pushed_to_user" | "queued_for_digest"

/** Per spec §4.3 — directive.action values. */
export type DirectiveAction = "pause" | "resume" | "kill" | "run_now" | "config_update" | "flush_pending"

// ─── Tentacle → Brain Payloads ──────────────────────────────────

export interface TentacleRegisterPayload {
  purpose: string
  runtime: string
  pid?: number
  capabilities?: {
    daemon: string[]
    agent: string[]
    consultation: { mode: ConsultationMode; batchThreshold?: number }
  }
  tools?: string[]
  version?: string
}

export interface ReportFindingPayload {
  findingId: string
  summary: string
  confidence: number
  details?: string
}

export interface DirectivePayload {
  action: string
  reason?: string
  interval?: string
  triggerMode?: "self" | "external"
  consultation?: {
    session_id: string
    request_id?: string
    decision: "push" | "hold" | "discard" | "revise" | "approved" | "rejected" | "question"
    feedback?: string
    questions?: string[]
    action?: {
      type: string
      approved: boolean
      content?: string
    }
  }
}

export interface HeartbeatTriggerPayload {
  tentacle_id: string
  prompt: string
}

export interface HeartbeatResultPayload {
  tentacle_id: string
  status: "ok" | "acted"
  actions?: string[]
  adjustments?: Array<{
    type: "change_frequency" | "add_source" | "remove_source" | "change_strategy"
    description: string
    params: Record<string, unknown>
  }>
}

// ─── Consultation batch mode types ────────────────────────────────

export interface ConsultationItem {
  id: string
  content: string
  tentacleJudgment: "important" | "reference" | "uncertain"
  reason: string
  sourceUrl?: string
  timestamp: string
}

export interface ConsultationRequestPayload {
  tentacle_id: string
  request_id: string
  session_id?: string
  parent_request_id?: string
  turn?: number
  mode: LegacyConsultationMode
  items?: ConsultationItem[]
  action?: {
    type: string
    description: string
    content?: string
  }
  summary: string
  context: string
  // New protocol fields (optional for backward compat)
  initial_message?: string
  item_count?: number
  urgency?: "urgent" | "normal" | "low"
}

export interface ConsultationReplyPayload {
  session_id: string
  requestId: string
  status: "active" | "waiting_user" | "waiting_tentacle" | "resolved" | "closed"
  decision: "send" | "discard" | "defer" | "question"
  approvedItemIds: string[]
  queuedPushCount: number
  notes: string
  questions?: string[]
  next_action?: "await_user" | "await_tentacle" | "none"
  // New protocol fields (optional for backward compat)
  consultation_id?: string
  client_request_id?: string  // original request_id from the tentacle's consultation_request
  message?: string
  actions_taken?: Array<{
    action: ConsultationAction
    item_ref: string
    push_id?: string
  }>
  continue?: boolean
}

export interface ConsultationSessionState {
  session_id: string
  tentacle_id: string
  mode: LegacyConsultationMode
  status: "open" | "waiting_user" | "waiting_tentacle" | "resolved" | "closed"
  turn: number
  created_at: string
  updated_at: string
}

// ─── New protocol types (skill-tentacle spec) ────────────────────

export interface ConsultationMessagePayload {
  consultation_id: string
  message: string
}

export interface ConsultationEndPayload {
  consultation_id: string
  reason?: string
}

export interface ConsultationClosePayload {
  consultation_id: string
  client_request_id?: string  // original request_id from the tentacle's consultation_request
  summary: string
  pushed_count: number
  discarded_count: number
  feedback?: string
}

export interface ToolRequestPayload {
  tool_name: string
  tool_call_id: string
  arguments: Record<string, unknown>
}

export interface ToolResultPayload {
  tool_call_id: string
  result: Record<string, unknown>
  success: boolean
  error?: string
}

// ─── Tentacle capability types ───────────────────────────────────

export type TentacleCapability =
  | "web_search"
  | "api_integration"
  | "llm_reasoning"
  | "content_generation"
  | "file_management"
  | "webhook_receiver"
  | "external_bot"
  | "scheduled_task"
  | "action_execution"
  | "database"
  | "media_processing"
  | "rss_fetch"
  | "content_analysis"
  | "quality_judgment"
