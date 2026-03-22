export type IpcMessageType =
  | "tentacle_register"
  | "report_finding"
  | "consultation_request"
  | "consultation_reply"
  | "consultation_done"
  | "directive"
  | "heartbeat_trigger"
  | "heartbeat_result"

export interface IpcMessage {
  type: IpcMessageType
  sender: string
  receiver: string
  payload: unknown
  timestamp: string
  message_id: string
}

export interface TentacleRegisterPayload {
  purpose: string
  runtime: string
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

// M3: Consultation batch mode types

export type ConsultationMode = "single" | "batch" | "action_confirm"

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
  mode: ConsultationMode
  items?: ConsultationItem[]
  action?: {
    type: string
    description: string
    content?: string
  }
  summary: string
  context: string
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
}

export interface ConsultationSessionState {
  session_id: string
  tentacle_id: string
  mode: ConsultationMode
  status: "open" | "waiting_user" | "waiting_tentacle" | "resolved" | "closed"
  turn: number
  created_at: string
  updated_at: string
}

// M3: Tentacle capability types

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
