import winston from "winston"
import { createLogger } from "./create-logger.js"
import * as path from "path"
import { getAgentLogsDir } from "./log-paths.js"

let logger: winston.Logger | null = null

export function initGatewayLogger(logDir: string, level: string, maxSizeMb: number, keepDays: number): void {
  const gatewayLogDir = getAgentLogsDir(logDir, "gateway")
  logger = createLogger({
    filename: path.join(gatewayLogDir, "events-%DATE%.log"),
    level,
    maxSize: `${maxSizeMb}m`,
    maxFiles: `${keepDays}d`,
  })
}

export const gatewayLogger = {
  info(event: string, meta?: Record<string, unknown>) {
    getLogger().info({ event, ...meta })
  },
  warn(event: string, meta?: Record<string, unknown>) {
    getLogger().warn({ event, ...meta })
  },
  error(event: string, meta?: Record<string, unknown>) {
    getLogger().error({ event, ...meta })
  },
  debug(event: string, meta?: Record<string, unknown>) {
    getLogger().debug({ event, ...meta })
  },
}

function getLogger(): winston.Logger {
  if (!logger) {
    throw new Error("Gateway logger not initialized. Call initGatewayLogger() first.")
  }
  return logger
}
