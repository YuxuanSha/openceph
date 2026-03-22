import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import * as os from "os"

export interface RuntimeStatusSnapshot {
  brain?: {
    running: boolean
    pid?: number
    model?: string
    sessionKey?: string
    inputTokens?: number
    outputTokens?: number
    updatedAt: string
  }
  gateway?: {
    running: boolean
    pid?: number
    port?: number
    channels?: string[]
    plugins?: string[]
    updatedAt: string
  }
  tentacles?: Array<{
    tentacleId: string
    status: string
    pid?: number
    purpose?: string
    healthScore?: number
    lastReportAt?: string
    updatedAt: string
  }>
}

const runtimeStatusPath = path.join(os.homedir(), ".openceph", "state", "runtime-status.json")

export async function readRuntimeStatus(): Promise<RuntimeStatusSnapshot> {
  if (!existsSync(runtimeStatusPath)) return {}
  try {
    return JSON.parse(await fs.readFile(runtimeStatusPath, "utf-8")) as RuntimeStatusSnapshot
  } catch {
    return {}
  }
}

export async function updateRuntimeStatus(
  patch: (current: RuntimeStatusSnapshot) => RuntimeStatusSnapshot,
): Promise<void> {
  const current = await readRuntimeStatus()
  const next = patch(current)
  await fs.mkdir(path.dirname(runtimeStatusPath), { recursive: true })
  await fs.writeFile(runtimeStatusPath, JSON.stringify(next, null, 2), "utf-8")
}
