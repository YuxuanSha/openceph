import winston from "winston"
import DailyRotateFile from "winston-daily-rotate-file"
import { mkdirSync } from "fs"
import * as path from "path"

export interface LoggerOptions {
  filename: string
  level: string
  maxSize: string
  maxFiles: string
}

export function createLogger(options: LoggerOptions): winston.Logger {
  mkdirSync(path.dirname(options.filename), { recursive: true })
  const transport = new DailyRotateFile({
    filename: options.filename,
    datePattern: "YYYY-MM-DD",
    maxSize: options.maxSize,
    maxFiles: options.maxFiles,
    format: winston.format.combine(
      winston.format.timestamp({ alias: "ts" }),
      winston.format.json(),
    ),
  })

  return winston.createLogger({
    level: options.level.toLowerCase(),
    format: winston.format.combine(
      winston.format.timestamp({ alias: "ts" }),
      winston.format.json(),
    ),
    transports: [transport],
  })
}
