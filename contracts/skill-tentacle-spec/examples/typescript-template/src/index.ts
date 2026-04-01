/**
 * Template Monitor — OpenCeph skill_tentacle TypeScript template
 *
 * Three-layer architecture:
 *   Layer 1 — Engineering Daemon (while loop, pure code)
 *   Layer 2 — Agent Capabilities (activate LLM on demand)
 *   Layer 3 — Consultation (multi-turn conversation with Brain)
 */

import { IpcClient, LlmClient, AgentLoop, TentacleLogger, TentacleConfig, StateDB, loadTools } from "@openceph/runtime"
import * as fs from "fs"
import * as path from "path"

// --- Configuration ---
const config = new TentacleConfig()
const log = new TentacleLogger()
const ipc = new IpcClient()
const db = new StateDB()

const TOPICS = (config.get("MONITOR_TOPICS") || "AI,LLM").split(",").map(t => t.trim())
const BATCH_THRESHOLD = config.batchThreshold
const POLL_INTERVAL = parseInt(config.get("POLL_INTERVAL_SECONDS") || "21600", 10) * 1000

// --- Global State ---
let shutdown = false
let paused = false
const pending: any[] = []

process.on("SIGTERM", () => { shutdown = true })
process.on("SIGINT", () => { shutdown = true })

// --- IPC Handlers ---
ipc.onDirective((action: string, params: Record<string, any>) => {
  log.daemon("directive_received", { action })
  if (action === "pause") paused = true
  else if (action === "resume") paused = false
  else if (action === "kill") shutdown = true
})

ipc.onConsultationReply((consultationId, message, actionsTaken, shouldContinue) => {
  for (const action of actionsTaken) {
    if (action.action === "pushed_to_user") {
      log.consultation("item_pushed", { id: consultationId, itemRef: action.item_ref })
    }
  }
  if (!shouldContinue) return

  // Brain asked a follow-up question; answer it
  const answer = answerBrainQuestion(message)
  ipc.consultationMessage(consultationId, answer)
})

ipc.onConsultationClose((consultationId, summary, pushedCount, discardedCount, feedback) => {
  log.consultation("ended", { id: consultationId, pushed: pushedCount, discarded: discardedCount })
  updateStatusMd()
  if (feedback) db.setState("last_brain_feedback", feedback)
})

// --- Layer 1: Engineering Logic (replace these functions) ---

async function fetchNewData(): Promise<any[]> {
  log.daemon("fetch_start", { source: "template", topics: TOPICS })
  const items: any[] = []
  // TODO: Implement data fetching
  log.daemon("fetch_end", { items: items.length })
  return items
}

function ruleFilter(items: any[]): any[] {
  const filtered = items.filter(item => {
    if (db.isProcessed(item.id)) return false
    db.markProcessed(item.id)
    // TODO: Implement filtering rules
    return true
  })
  log.daemon("rule_filter", { input: items.length, output: filtered.length })
  return filtered
}

function executeMyTool(toolName: string, args: Record<string, any>): string {
  // TODO: Implement custom tools
  return JSON.stringify({ error: `Not implemented: ${toolName}` })
}

// --- Layer 2: Agent Logic ---

async function activateAgent(pendingItems: any[]): Promise<any[]> {
  log.agent("activated", { pendingCount: pendingItems.length })

  const tools = loadTools("tools/tools.json")
  const systemPrompt = fs.readFileSync(path.join(config.workspace, "SYSTEM.md"), "utf-8")

  const agent = new AgentLoop({
    systemPrompt,
    tools,
    maxTurns: 20,
    ipc,
  })

  const result = await agent.run(
    formatItemsForAgent(pendingItems),
    executeMyTool,
  )

  return parseAgentResult(result)
}

async function answerBrainQuestion(question: string): Promise<string> {
  const llm = new LlmClient()
  const systemPrompt = fs.readFileSync(path.join(config.workspace, "SYSTEM.md"), "utf-8")
  const response = await llm.chat([
    { role: "system", content: systemPrompt },
    { role: "user", content: `Brain follow-up question: ${question}` },
  ])
  return response.content
}

// --- Helper Functions ---

function formatItemsForAgent(items: any[]): string {
  return `The following ${items.length} items are pending analysis:\n\n` +
    items.map((item, i) => `${i + 1}. ${item.title || "Unknown"}\n   ${item.summary || ""}`).join("\n\n")
}

function parseAgentResult(result: string): any[] {
  return [{ content: result, judgment: "reference" }]
}

function updateStatusMd(): void {
  const statusPath = path.join(config.workspace, "STATUS.md")
  fs.writeFileSync(statusPath, `# Runtime Status\n\n- Status: Normal\n- Total scanned: ${db.getStat("total_scanned")}\n`)
}

// --- Main Loop ---

async function main() {
  ipc.connect()
  ipc.register({ purpose: config.purpose, runtime: "typescript" })
  log.daemon("started", { triggerMode: config.triggerMode, pollInterval: POLL_INTERVAL })

  while (!shutdown) {
    if (paused) {
      await sleep(60000)
      continue
    }

    try {
      const raw = await fetchNewData()
      const filtered = ruleFilter(raw)
      pending.push(...filtered)
      db.incrementStat("total_scanned", raw.length)

      log.daemon("cycle_complete", { scanned: raw.length, filtered: filtered.length, pending: pending.length })

      if (pending.length >= BATCH_THRESHOLD) {
        const consultationItems = await activateAgent(pending)
        if (consultationItems.length > 0) {
          ipc.consultationRequest({
            mode: "batch",
            summary: `Found ${consultationItems.length} noteworthy items`,
            initialMessage: formatConsultationReport(consultationItems),
            context: { totalScanned: db.getStat("total_scanned") },
          })
          pending.length = 0
        }
      }

      ipc.statusUpdate({ status: "idle", pendingItems: pending.length, health: "ok" })
    } catch (err: any) {
      log.daemon("error", { error: err.message })
    }

    await sleep(POLL_INTERVAL)
  }

  ipc.close()
  log.daemon("stopped")
}

function formatConsultationReport(items: any[]): string {
  return `Filtered out ${items.length} items:\n\n` +
    items.map((item, i) => `${i + 1}. ${item.content?.substring(0, 200) || ""}`).join("\n\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// --- Entry Point ---

if (process.argv.includes("--dry-run")) {
  console.log(`✓ Tentacle ID: ${process.env.OPENCEPH_TENTACLE_ID}`)
  console.log(`✓ LLM Gateway: ${process.env.OPENCEPH_LLM_GATEWAY_URL}`)
  console.log(`✓ Topics: ${TOPICS.join(", ")}`)
  process.exit(0)
} else {
  main().catch(err => {
    console.error("Fatal:", err)
    process.exit(1)
  })
}
