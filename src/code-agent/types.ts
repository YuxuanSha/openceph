export interface CodeAgentSessionArtifact {
  sessionFile: string
  workDir: string
  logsDir?: string
  stdoutLog?: string
  stderrLog?: string
  terminalLog?: string
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
  resumedFromClaudeSessionId?: string
  reusedPreviousSession?: boolean
  reuseReason?: string
  brainSessionKey?: string
}
