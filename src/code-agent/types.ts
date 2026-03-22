export interface CodeAgentSessionArtifact {
  sessionFile: string
  workDir: string
  elapsedMs: number
  turnCount: number
  toolCalls: Array<{
    toolName: string
    toolCallId: string
    startedAt: string
    endedAt?: string
    success?: boolean
  }>
  finalText?: string
  claudeSessionId?: string
  modelId?: string
  resultSubtype?: string
  persistentSession?: boolean
}
