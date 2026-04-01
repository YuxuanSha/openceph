import * as fs from "fs/promises"
import * as path from "path"
import { brainLogger } from "../logger/index.js"
import type { TentacleManager } from "./manager.js"
import type { TentacleRegistry } from "./registry.js"
import type { TentacleHealthCalculator } from "./health-score.js"
import { CodeAgent, type MergeTentacleInfo } from "../code-agent/code-agent.js"
import { TentacleValidator } from "../code-agent/validator.js"
import { TentacleDeployer } from "../code-agent/deployer.js"
import type { CronScheduler } from "../cron/cron-scheduler.js"
import type { TentacleCapability } from "./contract.js"
import type { GeneratedCode } from "../code-agent/code-agent.js"

// ── Interfaces ──────────────────────────────────────────────────

export interface StrengthenConfig {
  newFrequency?: string
  additionalCapabilities?: TentacleCapability[]
  upgradeDescription?: string
}

export interface MergeConfig {
  newTentacleId: string
  newPurpose: string
  preferredRuntime?: string
}

export interface MergeResult {
  newTentacleId: string
  runtime: string
  directory: string
  killedTentacles: string[]
}

// Frequency tier for auto-downgrade
const FREQUENCY_TIERS = ["6h", "12h", "24h", "48h"]

// ── TentacleLifecycleManager ────────────────────────────────────

export class TentacleLifecycleManager {
  private validator: TentacleValidator
  private deployer: TentacleDeployer

  constructor(
    private tentacleManager: TentacleManager,
    private cronScheduler: CronScheduler | null,
    private codeAgent: CodeAgent,
    private registry: TentacleRegistry,
    private healthCalculator: TentacleHealthCalculator,
  ) {
    this.validator = new TentacleValidator()
    this.deployer = new TentacleDeployer(tentacleManager.getTentacleBaseDir())
  }

  /**
   * Weaken a tentacle: reduce its scheduling frequency.
   * If no newFrequency is provided, auto-downgrade to the next tier.
   */
  async weaken(tentacleId: string, config?: { newFrequency?: string }): Promise<void> {
    const currentSchedule = await this.tentacleManager.getTentacleSchedule(tentacleId)
    if (!currentSchedule) {
      throw new Error(`No schedule found for tentacle: ${tentacleId}`)
    }

    // Determine new frequency
    let newFrequency: string
    if (config?.newFrequency) {
      newFrequency = config.newFrequency
    } else {
      // Auto-downgrade: find current tier and move to next
      const currentInterval = currentSchedule.primaryTrigger.type === "self-schedule"
        ? currentSchedule.primaryTrigger.interval
        : "6h"
      newFrequency = getNextSlowerTier(currentInterval)
    }

    // Update schedule
    await this.tentacleManager.setTentacleSchedule(tentacleId, {
      ...currentSchedule,
      primaryTrigger: { type: "self-schedule", interval: newFrequency },
    })

    // Update status to weakened
    const status = this.tentacleManager.getStatus(tentacleId)
    if (status) {
      await this.registry.updateStatus(tentacleId, "weakened", {
        health: "weakened",
      })
    }

    brainLogger.info("tentacle_weakened", {
      tentacle_id: tentacleId,
      new_frequency: newFrequency,
      reason: config?.newFrequency ? "manual" : "auto_downgrade",
    })
  }

  /**
   * Strengthen a tentacle: increase frequency and/or upgrade capabilities.
   */
  async strengthen(tentacleId: string, config: StrengthenConfig): Promise<void> {
    // 1. Increase frequency if specified
    if (config.newFrequency) {
      const currentSchedule = await this.tentacleManager.getTentacleSchedule(tentacleId)
      if (currentSchedule) {
        await this.tentacleManager.setTentacleSchedule(tentacleId, {
          ...currentSchedule,
          primaryTrigger: { type: "self-schedule", interval: config.newFrequency },
        })
      }
    }

    // 2. Upgrade code if upgrade description provided
    if (config.upgradeDescription || config.additionalCapabilities?.length) {
      const tentacleDir = this.tentacleManager.getTentacleDir(tentacleId)
      const existingCode = await this.readTentacleCode(tentacleDir)
      const currentStatus = this.tentacleManager.getStatus(tentacleId)

      const patch = await this.codeAgent.generatePatch(existingCode, {
        tentacleId,
        description: config.upgradeDescription ?? "Add new capabilities",
        additionalCapabilities: config.additionalCapabilities,
        newFrequency: config.newFrequency,
      })

      const metadata = await this.readTentacleMetadata(tentacleDir)
      const currentFiles = await this.readTentacleCodeFiles(tentacleDir)
      const patchedCode = this.ensureContractCompatibility(
        this.applyPatchToGeneratedCode(currentFiles, metadata, patch),
        tentacleId,
        currentStatus?.purpose ?? metadata.description ?? tentacleId,
      )
      const validation = await this.validator.validateAll(patchedCode)
      if (!validation.passed) {
        const errors = [
          ...validation.checks.syntax.errors,
          ...validation.checks.contract.errors,
          ...validation.checks.security.errors,
          ...validation.checks.smoke.errors,
        ].map((error) => error.message)
        throw new Error(`Strengthen validation failed: ${errors.join("; ")}`)
      }

      // Apply patch files
      for (const file of patch.files) {
        const fullPath = path.join(tentacleDir, file.path)
        if (file.action === "delete") {
          await fs.unlink(fullPath).catch(() => {})
        } else {
          await fs.mkdir(path.dirname(fullPath), { recursive: true })
          await fs.writeFile(fullPath, file.content, "utf-8")
        }
      }

      // Restart tentacle to pick up changes
      await this.tentacleManager.kill(tentacleId, "strengthen_restart")
      await this.tentacleManager.spawn(tentacleId)
      await this.tentacleManager.waitForRegistration(tentacleId, 30_000)
    }

    // 3. Update registry status
    await this.registry.updateStatus(tentacleId, "running", {
      health: "good",
    })

    brainLogger.info("tentacle_strengthened", {
      tentacle_id: tentacleId,
      new_frequency: config.newFrequency,
      upgrade: config.upgradeDescription ?? "none",
      additional_capabilities: config.additionalCapabilities?.join(", ") ?? "none",
    })
  }

  /**
   * Merge multiple tentacles into a single new one.
   */
  async merge(tentacleIds: string[], config: MergeConfig): Promise<MergeResult> {
    if (tentacleIds.length < 2) {
      throw new Error("Merge requires at least 2 tentacles")
    }

    // 1. Read metadata and code from all source tentacles
    const tentacles: MergeTentacleInfo[] = []
    for (const id of tentacleIds) {
      const status = this.tentacleManager.getStatus(id)
      const dir = this.tentacleManager.getTentacleDir(id)
      const code = await this.readTentacleCodeFiles(dir)
      tentacles.push({
        tentacleId: id,
        purpose: status?.purpose ?? id,
        runtime: status?.runtime ?? "python",
        codeFiles: code,
      })
    }

    // 2. Generate merged code
    const generated = await this.codeAgent.generateMerged(tentacles, {
      newTentacleId: config.newTentacleId,
      newPurpose: config.newPurpose,
      preferredRuntime: config.preferredRuntime,
    })
    const normalized = this.ensureContractCompatibility(generated, config.newTentacleId, config.newPurpose)

    // 3. Validate
    const validation = await this.validator.validateAll(normalized)
    if (!validation.passed) {
      const errors = [
        ...validation.checks.syntax.errors,
        ...validation.checks.contract.errors,
        ...validation.checks.security.errors,
        ...validation.checks.smoke.errors,
      ].map((e) => e.message)
      throw new Error(`Merge validation failed: ${errors.join("; ")}`)
    }

    // 4. Deploy new tentacle
    const directory = await this.deployer.deploy(config.newTentacleId, normalized, {
      purpose: config.newPurpose,
      brief: `Merged from: ${tentacleIds.join(", ")}`,
    })

    // 5. Spawn new tentacle
    await this.tentacleManager.spawn(config.newTentacleId)
    const registered = await this.tentacleManager.waitForRegistration(config.newTentacleId, 30_000)
    if (!registered) {
      throw new Error(`Merged tentacle did not register: ${config.newTentacleId}`)
    }

    // 6. Kill original tentacles (preserve their directories and logs)
    for (const id of tentacleIds) {
      await this.tentacleManager.kill(id, `merged into ${config.newTentacleId}`)
    }

    // 7. Update TENTACLES.md
    await this.registry.updateStatus(config.newTentacleId, "running", {
      purpose: config.newPurpose,
      runtime: normalized.runtime,
      health: "good",
    })

    brainLogger.info("tentacle_merged", {
      source_tentacles: tentacleIds,
      new_tentacle_id: config.newTentacleId,
      new_purpose: config.newPurpose,
      runtime: normalized.runtime,
    })

    return {
      newTentacleId: config.newTentacleId,
      runtime: normalized.runtime,
      directory,
      killedTentacles: tentacleIds,
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private async readTentacleCode(dir: string): Promise<string> {
    const files = await this.readTentacleCodeFiles(dir)
    return files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")
  }

  private async readTentacleCodeFiles(dir: string): Promise<{ path: string; content: string }[]> {
    const files: { path: string; content: string }[] = []
    const walk = async (currentDir: string, prefix: string) => {
      let entries
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (["venv", "node_modules", "__pycache__", ".git", "db"].includes(entry.name)) continue
          await walk(path.join(currentDir, entry.name), relPath)
        } else if (/\.(py|ts|js|go|sh|json|txt)$/.test(entry.name) && entry.name !== "tentacle.json") {
          try {
            const content = await fs.readFile(path.join(currentDir, entry.name), "utf-8")
            files.push({ path: relPath, content })
          } catch {
            // Skip unreadable files
          }
        }
      }
    }
    await walk(dir, "")
    return files
  }

  private async readTentacleMetadata(dir: string): Promise<{
    runtime?: string
    entryCommand?: string
    setupCommands?: string[]
    envVars?: string[]
    ports?: number[]
    description?: string
    dependencies?: string
  }> {
    try {
      const raw = await fs.readFile(path.join(dir, "tentacle.json"), "utf-8")
      return JSON.parse(raw) as {
        runtime?: string
        entryCommand?: string
        setupCommands?: string[]
        envVars?: string[]
        ports?: number[]
        description?: string
        dependencies?: string
      }
    } catch {
      return {}
    }
  }

  private applyPatchToGeneratedCode(
    files: { path: string; content: string }[],
    metadata: {
      runtime?: string
      entryCommand?: string
      setupCommands?: string[]
      envVars?: string[]
      ports?: number[]
      description?: string
      dependencies?: string
    },
    patch: {
      files: { path: string; content: string; action: "create" | "replace" | "delete" }[]
      description: string
    },
  ): GeneratedCode {
    const next = new Map(files.map((file) => [file.path, file.content]))
    for (const file of patch.files) {
      if (file.action === "delete") next.delete(file.path)
      else next.set(file.path, file.content)
    }

    const fileList = Array.from(next.entries()).map(([path, content]) => ({ path, content }))
    return {
      runtime: metadata.runtime ?? inferRuntime(fileList.map((file) => file.path)),
      files: fileList,
      entryCommand: metadata.entryCommand ?? inferEntryCommand(fileList.map((file) => file.path)),
      setupCommands: metadata.setupCommands ?? [],
      dependencies: metadata.dependencies,
      envVars: metadata.envVars ?? ["OPENCEPH_TENTACLE_ID", "OPENCEPH_TRIGGER_MODE"],
      ports: metadata.ports,
      description: patch.description || metadata.description || "Strengthened tentacle patch",
    }
  }

  private ensureContractCompatibility(code: GeneratedCode, tentacleId: string, purpose: string): GeneratedCode {
    const aggregate = code.files.map((file) => file.content).join("\n")
    const hasContractMarkers = [
      "consultation_request",
      "OPENCEPH_TRIGGER_MODE",
      "pause",
      "resume",
      "run_now",
      "kill",
    ].every((token) => aggregate.includes(token))

    if (hasContractMarkers) {
      return {
        ...code,
        envVars: Array.from(new Set(code.envVars ?? ["OPENCEPH_TENTACLE_ID", "OPENCEPH_TRIGGER_MODE"])),
      }
    }

    const runtime = code.runtime ?? inferRuntime(code.files.map((file) => file.path))
    if (runtime === "python") {
      const preserved = code.files.map((file) => ({ path: file.path, content: file.content }))
      const filtered = preserved.filter((file) => file.path !== "main.py")
      filtered.push({
        path: "main.py",
        content: buildLifecyclePythonMain(tentacleId, purpose),
      })
      if (!filtered.some((file) => file.path === "LEGACY_CODE_SNAPSHOT.txt")) {
        filtered.push({
          path: "LEGACY_CODE_SNAPSHOT.txt",
          content: preserved.map((file) => `--- ${file.path} ---\n${file.content}`).join("\n\n"),
        })
      }
      return {
        ...code,
        runtime: "python",
        files: filtered,
        entryCommand: "python3 main.py",
        envVars: Array.from(new Set([...(code.envVars ?? []), "OPENCEPH_TENTACLE_ID", "OPENCEPH_TRIGGER_MODE"])),
      }
    }

    return {
      ...code,
      envVars: Array.from(new Set([...(code.envVars ?? []), "OPENCEPH_TENTACLE_ID", "OPENCEPH_TRIGGER_MODE"])),
    }
  }
}

/**
 * Given a current interval, return the next slower tier.
 * Tiers: 6h → 12h → 24h → 48h
 */
function getNextSlowerTier(currentInterval: string): string {
  const idx = FREQUENCY_TIERS.indexOf(currentInterval)
  if (idx >= 0 && idx < FREQUENCY_TIERS.length - 1) {
    return FREQUENCY_TIERS[idx + 1]
  }
  // If not in tiers, try to parse and double
  const match = currentInterval.match(/^(\d+)(h|m|d)$/)
  if (match) {
    const value = parseInt(match[1], 10)
    const unit = match[2]
    return `${value * 2}${unit}`
  }
  return "48h" // Max fallback
}

function inferRuntime(files: string[]): GeneratedCode["runtime"] {
  if (files.some((file) => file.endsWith(".py"))) return "python"
  if (files.some((file) => file.endsWith(".ts"))) return "typescript"
  if (files.some((file) => file.endsWith(".go"))) return "go"
  return "shell"
}

function inferEntryCommand(files: string[]): string {
  if (files.includes("main.py")) return "./venv/bin/python main.py"
  if (files.includes("src/main.ts")) return "npx tsx src/main.ts"
  if (files.includes("main.go")) return "go run main.go"
  return "bash main.sh"
}

function buildLifecyclePythonMain(tentacleId: string, purpose: string): string {
  return `import json
import os
import sys
import threading
import time
import uuid

STOP = False
PAUSED = False
TRIGGER_MODE = os.environ.get("OPENCEPH_TRIGGER_MODE", "external")
TENTACLE_ID = os.environ.get("OPENCEPH_TENTACLE_ID", ${JSON.stringify(tentacleId)})
PURPOSE = ${JSON.stringify(purpose)}

def send(msg_type, payload):
    sys.stdout.write(json.dumps({
        "type": msg_type,
        "sender": TENTACLE_ID,
        "receiver": "brain",
        "payload": payload,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "message_id": str(uuid.uuid4())
    }) + "\\n")
    sys.stdout.flush()

def emit_consultation(reason):
    send("consultation_request", {
        "tentacle_id": TENTACLE_ID,
        "request_id": str(uuid.uuid4()),
        "session_id": str(uuid.uuid4()),
        "turn": 1,
        "mode": "batch",
        "summary": "Lifecycle compatibility consultation",
        "context": f"reason={reason}; trigger={TRIGGER_MODE}",
        "items": [{
            "id": "compatibility-item",
            "content": PURPOSE,
            "tentacleJudgment": "important",
            "reason": "Lifecycle compatibility upgrade",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }]
    })

def handle_directive(message):
    global STOP, PAUSED
    action = (message.get("payload") or {}).get("action")
    if action == "pause":
        PAUSED = True
    elif action == "resume":
        PAUSED = False
    elif action == "run_now":
        if not PAUSED:
            emit_consultation("run_now")
    elif action == "kill":
        STOP = True
        sys.exit(0)

def reader():
    global STOP
    for part in sys.stdin:
        if STOP:
            break
        if not part.strip():
            continue
        try:
            message = json.loads(part)
            if message.get("type") == "directive":
                handle_directive(message)
        except Exception:
            continue

send("tentacle_register", {"purpose": PURPOSE, "runtime": "python", "triggerMode": TRIGGER_MODE})
emit_consultation("boot")
threading.Thread(target=reader, daemon=True).start()

while not STOP:
    time.sleep(0.1)
`
}
