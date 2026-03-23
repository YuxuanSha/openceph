import { createWriteStream, type WriteStream } from "fs"
import { mkdirSync } from "fs"
import * as path from "path"
import { getAgentLogsDir, getStreamLogPaths } from "./log-paths.js"

interface RuntimeSink {
  stdout: WriteStream
  stderr: WriteStream
  terminal: WriteStream
}

const sinks = new Map<string, RuntimeSink>()
let patched = false

export function initProcessRuntimeCapture(logDir: string, agentId: string): {
  logsDir: string
  stdoutLog: string
  stderrLog: string
  terminalLog: string
} {
  const logsDir = getAgentLogsDir(logDir, agentId)
  const streamLogs = getStreamLogPaths(logsDir)
  if (!sinks.has(agentId)) {
    mkdirSync(logsDir, { recursive: true })
    sinks.set(agentId, {
      stdout: createWriteStream(streamLogs.stdoutLog, { flags: "a" }),
      stderr: createWriteStream(streamLogs.stderrLog, { flags: "a" }),
      terminal: createWriteStream(streamLogs.terminalLog, { flags: "a" }),
    })
  }
  if (!patched) {
    patched = true
    patchStream(process.stdout, "stdout")
    patchStream(process.stderr, "stderr")
  }
  return streamLogs
}

function patchStream(stream: NodeJS.WriteStream, streamName: "stdout" | "stderr") {
  const originalWrite = stream.write.bind(stream)
  stream.write = ((chunk: any, encoding?: any, callback?: any) => {
    const text = toText(chunk, encoding)
    for (const sink of sinks.values()) {
      const target = streamName === "stdout" ? sink.stdout : sink.stderr
      target.write(text)
      const combined = text
        .split(/(?<=\n)/)
        .filter(Boolean)
        .map((part) => `[${streamName}] ${part}`)
        .join("")
      sink.terminal.write(combined)
    }
    return originalWrite(chunk, encoding, callback)
  }) as typeof stream.write
}

function toText(chunk: unknown, encoding?: BufferEncoding): string {
  if (typeof chunk === "string") return chunk
  if (Buffer.isBuffer(chunk)) return chunk.toString(encoding ?? "utf-8")
  return String(chunk)
}

export function getAgentRuntimeArtifactPaths(logDir: string, agentId: string): {
  logsDir: string
  stdoutLog: string
  stderrLog: string
  terminalLog: string
} {
  return getStreamLogPaths(getAgentLogsDir(logDir, agentId))
}
