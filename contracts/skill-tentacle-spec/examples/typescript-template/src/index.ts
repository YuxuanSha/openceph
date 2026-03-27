/**
 * Template Monitor — OpenCeph skill_tentacle TypeScript 模板
 *
 * 三层架构：
 *   第一层 — 工程 Daemon（while 循环，纯代码）
 *   第二层 — Agent 能力（按策略激活 LLM）
 *   第三层 — Consultation（与 Brain 多轮对话）
 */

import { IpcClient, LlmClient, AgentLoop, TentacleLogger, TentacleConfig, StateDB, loadTools } from "@openceph/runtime"
import * as fs from "fs"
import * as path from "path"

// ━━━ 配置 ━━━
const config = new TentacleConfig()
const log = new TentacleLogger()
const ipc = new IpcClient()
const db = new StateDB()

const TOPICS = (config.get("MONITOR_TOPICS") || "AI,LLM").split(",").map(t => t.trim())
const BATCH_THRESHOLD = config.batchThreshold
const POLL_INTERVAL = parseInt(config.get("POLL_INTERVAL_SECONDS") || "21600", 10) * 1000

// ━━━ 全局状态 ━━━
let shutdown = false
let paused = false
const pending: any[] = []

process.on("SIGTERM", () => { shutdown = true })
process.on("SIGINT", () => { shutdown = true })

// ━━━ IPC Handlers ━━━
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

  // Brain 追问，回答
  const answer = answerBrainQuestion(message)
  ipc.consultationMessage(consultationId, answer)
})

ipc.onConsultationClose((consultationId, summary, pushedCount, discardedCount, feedback) => {
  log.consultation("ended", { id: consultationId, pushed: pushedCount, discarded: discardedCount })
  updateStatusMd()
  if (feedback) db.setState("last_brain_feedback", feedback)
})

// ━━━ 第一层：工程逻辑（替换这些函数）━━━

async function fetchNewData(): Promise<any[]> {
  log.daemon("fetch_start", { source: "template", topics: TOPICS })
  const items: any[] = []
  // TODO: 实现数据抓取
  log.daemon("fetch_end", { items: items.length })
  return items
}

function ruleFilter(items: any[]): any[] {
  const filtered = items.filter(item => {
    if (db.isProcessed(item.id)) return false
    db.markProcessed(item.id)
    // TODO: 实现过滤规则
    return true
  })
  log.daemon("rule_filter", { input: items.length, output: filtered.length })
  return filtered
}

function executeMyTool(toolName: string, args: Record<string, any>): string {
  // TODO: 实现自建工具
  return JSON.stringify({ error: `Not implemented: ${toolName}` })
}

// ━━━ 第二层：Agent 逻辑 ━━━

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
    { role: "user", content: `Brain 追问：${question}` },
  ])
  return response.content
}

// ━━━ 辅助函数 ━━━

function formatItemsForAgent(items: any[]): string {
  return `以下是 ${items.length} 条待分析的内容：\n\n` +
    items.map((item, i) => `${i + 1}. ${item.title || "未知"}\n   ${item.summary || ""}`).join("\n\n")
}

function parseAgentResult(result: string): any[] {
  return [{ content: result, judgment: "reference" }]
}

function updateStatusMd(): void {
  const statusPath = path.join(config.workspace, "STATUS.md")
  fs.writeFileSync(statusPath, `# 运行状态\n\n- 状态：正常\n- 扫描总数：${db.getStat("total_scanned")}\n`)
}

// ━━━ 主循环 ━━━

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
            summary: `发现 ${consultationItems.length} 条值得关注的内容`,
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
  return `筛选出 ${items.length} 条内容：\n\n` +
    items.map((item, i) => `${i + 1}. ${item.content?.substring(0, 200) || ""}`).join("\n\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ━━━ 入口 ━━━

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
