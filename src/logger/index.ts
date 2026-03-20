import type { OpenCephConfig } from "../config/config-schema.js"
import { initBrainLogger } from "./brain-logger.js"
import { initGatewayLogger } from "./gateway-logger.js"
import { initSystemLogger } from "./system-logger.js"
import { initCostLogger } from "./cost-logger.js"
import { initTentacleLoggerConfig } from "./tentacle-logger.js"
import { initCacheTraceLogger } from "./cache-trace-logger.js"
import { mkdirSync, existsSync } from "fs"

export function initLoggers(config: OpenCephConfig): void {
  const { logDir, level, rotateSizeMb, keepDays } = config.logging

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }

  initBrainLogger(logDir, level, rotateSizeMb, keepDays)
  initGatewayLogger(logDir, level, rotateSizeMb, keepDays)
  initSystemLogger(logDir, level, rotateSizeMb, keepDays)
  initCostLogger(logDir, level, rotateSizeMb, keepDays)
  initTentacleLoggerConfig(logDir, level, rotateSizeMb, keepDays)

  if (config.logging.cacheTrace) {
    initCacheTraceLogger(logDir)
  }
}

export { brainLogger } from "./brain-logger.js"
export { gatewayLogger } from "./gateway-logger.js"
export { systemLogger } from "./system-logger.js"
export { costLogger } from "./cost-logger.js"
export { tentacleLog } from "./tentacle-logger.js"
export { writeCacheTrace } from "./cache-trace-logger.js"
