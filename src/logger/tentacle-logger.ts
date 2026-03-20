import winston from "winston"
import { createLogger } from "./create-logger.js"
import * as path from "path"

const loggers = new Map<string, winston.Logger>()
let logDir: string | null = null
let logLevel = "info"
let maxSizeMb = 50
let keepDays = 30

export function initTentacleLoggerConfig(dir: string, level: string, sizeMb: number, days: number): void {
  logDir = dir
  logLevel = level
  maxSizeMb = sizeMb
  keepDays = days
}

function getOrCreateLogger(tentacleId: string): winston.Logger {
  if (!logDir) {
    throw new Error("Tentacle logger not initialized. Call initTentacleLoggerConfig() first.")
  }

  let logger = loggers.get(tentacleId)
  if (!logger) {
    logger = createLogger({
      filename: path.join(logDir, `tentacle-${tentacleId}-%DATE%.log`),
      level: logLevel,
      maxSize: `${maxSizeMb}m`,
      maxFiles: `${keepDays}d`,
    })
    loggers.set(tentacleId, logger)
  }
  return logger
}

export function tentacleLog(tentacleId: string, level: "info" | "warn" | "error" | "debug", event: string, meta?: Record<string, unknown>): void {
  const logger = getOrCreateLogger(tentacleId)
  logger[level]({ event, tentacle_id: tentacleId, ...meta })
}
