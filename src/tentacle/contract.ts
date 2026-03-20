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
}

export interface HeartbeatTriggerPayload {
  reason: string
}

export interface HeartbeatResultPayload {
  ok: boolean
  details?: string
}
