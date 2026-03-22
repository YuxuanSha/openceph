import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { initLoggers } from "../../src/logger/index.js"
import type { GeneratedCode } from "../../src/code-agent/code-agent.js"

export function createTempIntegrationDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(dir, "workspace"), { recursive: true })
  fs.writeFileSync(path.join(dir, "workspace", "TENTACLES.md"), "# TENTACLES.md\n")
  return dir
}

export function initIntegrationConfig(dir: string, skillPaths: string[] = []) {
  initLoggers({
    meta: { version: "3.2" },
    gateway: { port: 18790, bind: "loopback", auth: { mode: "token", token: "x" } },
    agents: { defaults: { workspace: path.join(dir, "workspace"), model: { primary: "anthropic/claude-sonnet-4-5", fallbacks: [] }, userTimezone: "UTC", bootstrapMaxChars: 20000, bootstrapTotalMaxChars: 150000 } },
    models: { providers: {} },
    auth: { profiles: {}, order: {}, cooldown: "5m", cacheRetention: "long" },
    channels: { telegram: { enabled: false, dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled", streaming: true, ackReaction: { emoji: "🐙", direct: true }, textChunkLimit: 4000 }, feishu: { enabled: false, dmPolicy: "pairing", allowFrom: [], domain: "feishu", streaming: true, groupPolicy: "disabled" }, webchat: { enabled: true, port: 18791, auth: { mode: "token" } } },
    mcp: { servers: {}, webSearch: { cacheTtlMinutes: 15 }, webFetch: { maxCharsCap: 50000 } },
    skills: { paths: skillPaths },
    tentacle: { maxActive: 20, ipcSocketPath: path.join(dir, "sock"), codeGenMaxRetries: 3, crashRestartMaxAttempts: 3, confidenceThresholds: { directReport: 0.8, consultation: 0.4, discard: 0 } },
    push: { defaultTiming: "best_time", preferredWindowStart: "09:00", preferredWindowEnd: "10:00", maxDailyPushes: 3, feedback: { ignoreWindowHours: 24 } },
    session: { dmScope: "main", mainKey: "main", reset: { mode: "daily", atHour: 4 }, resetTriggers: ["/new"], cleanup: { maxArchiveFilesPerKey: 30, archiveTtlDays: 90, heartbeatRetentionDays: 7, consultationRetentionDays: 30 } },
    logging: { logDir: path.join(dir, "logs"), level: "INFO", rotateSizeMb: 5, keepDays: 1, cacheTrace: false },
    cost: { dailyLimitUsd: 0.5, alertThresholdUsd: 0.4 },
    commands: { config: false, debug: false, bash: false },
    tools: { loopDetection: { enabled: true, warningThreshold: 10, criticalThreshold: 20, historySize: 30, detectors: { genericRepeat: true, knownPollNoProgress: true, pingPong: true } } },
    cron: { timezone: "UTC", maxConcurrentRuns: 2, runLog: { keepSuccess: 20, keepFailure: 20 }, isolatedSessionRetention: { keepMax: 10, ttlDays: 14 }, retry: { maxAttempts: 1, backoffMs: [10] } },
    heartbeat: { every: "6h", model: "anthropic/claude-sonnet-4-5" },
  } as any)

  return {
    tentacle: { ipcSocketPath: path.join(dir, "sock"), codeGenMaxRetries: 3, crashRestartMaxAttempts: 3, confidenceThresholds: { directReport: 0.8, consultation: 0.4, discard: 0 } },
    agents: { defaults: { workspace: path.join(dir, "workspace"), model: { primary: "anthropic/claude-sonnet-4-5", fallbacks: [] } } },
    skills: { paths: skillPaths },
    push: { defaultTiming: "best_time", preferredWindowStart: "09:00", preferredWindowEnd: "10:00", maxDailyPushes: 3, feedback: { ignoreWindowHours: 24 } },
    cron: { timezone: "UTC", maxConcurrentRuns: 2, runLog: { keepSuccess: 20, keepFailure: 20 }, isolatedSessionRetention: { keepMax: 10, ttlDays: 14 }, retry: { maxAttempts: 1, backoffMs: [10] } },
    heartbeat: { every: "6h", model: "anthropic/claude-sonnet-4-5" },
    logging: { logDir: path.join(dir, "logs") },
  } as any
}

export function makeApprovedItem(overrides: Partial<{
  itemId: string
  tentacleId: string
  content: string
  priority: "urgent" | "high" | "normal" | "low"
  timelinessHint: "immediate" | "today" | "this_week" | "anytime"
  needsUserAction: boolean
  approvedAt: string
}> = {}) {
  return {
    itemId: overrides.itemId ?? "item-1",
    tentacleId: overrides.tentacleId ?? "t_test",
    content: overrides.content ?? "Test update",
    originalItems: ["src-1"],
    priority: overrides.priority ?? "normal",
    timelinessHint: overrides.timelinessHint ?? "today",
    needsUserAction: overrides.needsUserAction ?? false,
    approvedAt: overrides.approvedAt ?? new Date().toISOString(),
    status: "pending" as const,
  }
}

export function makePythonTentacleCode(tentacleId: string, purpose: string): GeneratedCode {
  return {
    runtime: "python",
    files: [
      {
        path: "main.py",
        content: `import json
import os
import socket
import threading
import time
import uuid

STOP = False

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["OPENCEPH_SOCKET_PATH"])

def send(msg_type, payload):
    sock.sendall((json.dumps({
        "type": msg_type,
        "sender": os.environ.get("OPENCEPH_TENTACLE_ID", ${JSON.stringify(tentacleId)}),
        "receiver": "brain",
        "payload": payload,
        "timestamp": "x",
        "message_id": str(uuid.uuid4())
    }) + "\\n").encode("utf-8"))

def reader():
    global STOP
    buffer = ""
    while not STOP:
        data = sock.recv(4096)
        if not data:
            break
        buffer += data.decode("utf-8")
        parts = buffer.split("\\n")
        buffer = parts.pop() or ""
        for part in parts:
            if not part.strip():
                continue
            message = json.loads(part)
            if message.get("type") == "directive" and (message.get("payload") or {}).get("action") == "kill":
                STOP = True

send("tentacle_register", {"purpose": ${JSON.stringify(purpose)}, "runtime": "python"})
send("report_finding", {"findingId": "boot", "summary": "boot ok", "confidence": 0.9})

threading.Thread(target=reader, daemon=True).start()
while not STOP:
    time.sleep(0.1)
`,
      },
    ],
    entryCommand: "python3 main.py",
    setupCommands: [],
    envVars: ["OPENCEPH_SOCKET_PATH", "OPENCEPH_TENTACLE_ID", "OPENCEPH_TRIGGER_MODE"],
    description: purpose,
  }
}
