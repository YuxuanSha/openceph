import * as path from "path"

export function resolveOpenCephHomeFromLogDir(logDir: string): string {
  return path.dirname(logDir)
}

export function getAgentLogsDir(logDir: string, agentId: string): string {
  return path.join(resolveOpenCephHomeFromLogDir(logDir), "agents", agentId, "logs")
}

export function getTentacleLogsDir(logDir: string, tentacleId: string): string {
  return path.join(resolveOpenCephHomeFromLogDir(logDir), "tentacles", tentacleId, "logs")
}

export function getCodeAgentRunLogsDir(logDir: string, sessionFile: string): string {
  const sessionBase = path.basename(sessionFile, path.extname(sessionFile))
  return path.join(getAgentLogsDir(logDir, "code-agent"), "runs", sessionBase)
}

export function getStreamLogPaths(logsDir: string): {
  logsDir: string
  stdoutLog: string
  stderrLog: string
  terminalLog: string
} {
  return {
    logsDir,
    stdoutLog: path.join(logsDir, "stdout.log"),
    stderrLog: path.join(logsDir, "stderr.log"),
    terminalLog: path.join(logsDir, "terminal.log"),
  }
}
