import winston from "winston"
import { createLogger } from "./create-logger.js"
import * as path from "path"

let logger: winston.Logger | null = null

export function initSystemLogger(logDir: string, level: string, maxSizeMb: number, keepDays: number): void {
  logger = createLogger({
    filename: path.join(logDir, "system-%DATE%.log"),
    level,
    maxSize: `${maxSizeMb}m`,
    maxFiles: `${keepDays}d`,
  })
}

export const systemLogger = {
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
    throw new Error("System logger not initialized. Call initSystemLogger() first.")
  }
  return logger
}
