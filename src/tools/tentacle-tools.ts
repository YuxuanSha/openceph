import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import * as fs from "fs/promises"
import * as path from "path"
import type { ToolRegistryEntry } from "./index.js"
import { TentacleManager } from "../tentacle/manager.js"
import { SkillSpawner, type SpawnParams } from "../skills/skill-spawner.js"
import type { TentacleScheduleConfig } from "../tentacle/tentacle-schedule.js"
import type { TentacleLifecycleManager, StrengthenConfig, MergeConfig } from "../tentacle/lifecycle.js"
import type { TentacleReviewEngine } from "../tentacle/review-engine.js"
import { brainLogger } from "../logger/index.js"
import { getTentacleLogsDir, getStreamLogPaths } from "../logger/log-paths.js"

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined }
}

function normalizeScheduleAction(action: string): string {
  if (action === "update_self_schedule_config") return "set_self_schedule"
  return action
}

function normalizeDurationInput(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/^every\s+/, "")
  if (!trimmed) {
    throw new Error("Duration cannot be empty")
  }
  if (/^\d+(?:\.\d+)?(?:ms|s|m|h|d|w)$/.test(trimmed)) {
    return trimmed
  }
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(milliseconds?|millisecond|msecs?|msec|secs?|sec|seconds?|minutes?|mins?|min|hours?|hrs?|hr|days?|day|weeks?|week)$/)
  if (!match) {
    throw new Error(`Invalid duration: ${input}`)
  }
  const unitMap: Record<string, string> = {
    millisecond: "ms",
    milliseconds: "ms",
    msec: "ms",
    msecs: "ms",
    sec: "s",
    secs: "s",
    second: "s",
    seconds: "s",
    min: "m",
    mins: "m",
    minute: "m",
    minutes: "m",
    hr: "h",
    hrs: "h",
    hour: "h",
    hours: "h",
    day: "d",
    days: "d",
    week: "w",
    weeks: "w",
  }
  return `${match[1]}${unitMap[match[2]]}`
}

async function resolveTentacleArtifacts(
  manager: TentacleManager,
  logDir: string,
  tentacleId: string,
): Promise<{
  tentacleDir: string
  logsDir: string
  stdoutLog: string
  stderrLog: string
  terminalLog: string
  eventsLog?: string
  dataPaths: string[]
}> {
  const tentacleDir = manager.getTentacleDir(tentacleId)
  const preferredLogsDir = getTentacleLogsDir(logDir, tentacleId)
  const legacyRuntimeDir = path.join(tentacleDir, "runtime")
  let logsDir = preferredLogsDir
  try {
    await fs.stat(preferredLogsDir)
  } catch {
    try {
      await fs.stat(legacyRuntimeDir)
      logsDir = legacyRuntimeDir
    } catch {
      logsDir = preferredLogsDir
    }
  }
  const streamLogs = getStreamLogPaths(logsDir)

  let eventsLog: string | undefined
  try {
    const files = (await fs.readdir(logsDir))
      .filter((file) => file.startsWith("events-"))
      .sort()
    const latest = files.at(-1)
    if (latest) {
      eventsLog = path.join(logsDir, latest)
    }
  } catch {
    eventsLog = undefined
  }

  const dataCandidates = [
    path.join(tentacleDir, ".env"),
    path.join(tentacleDir, "tentacle.json"),
    path.join(tentacleDir, "data"),
    path.join(tentacleDir, "sessions"),
  ]

  try {
    const entries = await fs.readdir(tentacleDir)
    for (const entry of entries) {
      if (entry.endsWith(".db") || entry.endsWith(".sqlite") || entry.endsWith(".sqlite3")) {
        dataCandidates.push(path.join(tentacleDir, entry))
      }
    }
  } catch {
    // Ignore missing tentacle directories here; inspect command will surface paths anyway.
  }

  const dataPaths: string[] = []
  for (const candidate of dataCandidates) {
    try {
      await fs.stat(candidate)
      dataPaths.push(candidate)
    } catch {
      // Ignore missing artifacts.
    }
  }

  return {
    tentacleDir,
    logsDir,
    stdoutLog: streamLogs.stdoutLog,
    stderrLog: streamLogs.stderrLog,
    terminalLog: streamLogs.terminalLog,
    eventsLog,
    dataPaths,
  }
}

async function tailTextFile(filePath: string, nLines: number): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    const lines = content.trimEnd().split("\n")
    return lines.slice(-nLines).join("\n")
  } catch {
    return ""
  }
}

export function createTentacleTools(
  manager: TentacleManager,
  logDir: string,
  skillSpawner: SkillSpawner,
  lifecycleManager?: TentacleLifecycleManager,
  reviewEngine?: TentacleReviewEngine,
): ToolRegistryEntry[] {
  const listTentacles: ToolDefinition = {
    name: "list_tentacles",
    label: "List Tentacles",
    description: "列出当前所有触手的状态。部署后确认触手是否成功上线时用这个。",
    parameters: Type.Object({
      status_filter: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("active"),
        Type.Literal("running"),
        Type.Literal("registered"),
        Type.Literal("deploying"),
        Type.Literal("pending"),
        Type.Literal("paused"),
        Type.Literal("weakened"),
        Type.Literal("killed"),
        Type.Literal("crashed"),
      ], {
        description: "按状态过滤。合法值：all / active / running / registered / deploying / pending / paused / weakened / killed / crashed。不确定就用 all。",
      })),
    }),
    async execute(_id, params: any) {
      const filter = params.status_filter ?? "all"
      const items = manager.listAll()
      const filtered = filter === "all"
        ? items
        : filter === "active"
          ? items.filter((item) => ["running", "registered", "paused", "weakened"].includes(item.status))
          : items.filter((item) => item.status === filter)
      if (filtered.length === 0) return ok("No tentacles found.")
      const rendered = await Promise.all(filtered.map(async (item) => {
        const artifacts = await resolveTentacleArtifacts(manager, logDir, item.tentacleId)
        return [
          item.tentacleId,
          `status=${item.status}`,
          `pid=${item.pid ?? "-"}`,
          `purpose=${item.purpose ?? "-"}`,
          `trigger=${item.triggerSchedule ?? "-"}`,
          `heartbeat=${item.scheduleConfig?.heartbeat?.enabled ? item.scheduleConfig.heartbeat.every : "off"}`,
          `cron_jobs=${item.scheduleConfig?.cronJobs?.length ?? 0}`,
          `directory=${artifacts.tentacleDir}`,
          `log_dir=${artifacts.logsDir}`,
          `terminal_log=${artifacts.terminalLog}`,
          `stdout_log=${artifacts.stdoutLog}`,
          `stderr_log=${artifacts.stderrLog}`,
          `events_log=${artifacts.eventsLog ?? "-"}`,
          `data_paths=${artifacts.dataPaths.length > 0 ? artifacts.dataPaths.join(", ") : "-"}`,
        ].join("\n")
      }))
      return ok(rendered.join("\n\n"))
    },
  }

  const manageTentacle: ToolDefinition = {
    name: "manage_tentacle",
    label: "Manage Tentacle",
    description: `管理触手的运行状态。
    pause: 暂停（仅 running 状态可用）
    resume: 恢复（仅 paused 状态可用）
    kill: 停止（running 或 paused 可用）
    run_now: 立即触发一次执行（仅 running 状态可用）
    注意：killed 的触手不能 resume，需要重新 spawn_from_skill。`,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("weaken"),
        Type.Literal("strengthen"),
        Type.Literal("merge"),
        Type.Literal("kill"),
        Type.Literal("run_now"),
      ]),
      tentacle_ids: Type.Array(Type.String()),
      reason: Type.Optional(Type.String()),
      weaken_config: Type.Optional(Type.Object({
        new_frequency: Type.Optional(Type.String()),
      })),
      strengthen_config: Type.Optional(Type.Object({
        new_frequency: Type.Optional(Type.String()),
        additional_capabilities: Type.Optional(Type.Array(Type.String())),
        upgrade_description: Type.Optional(Type.String()),
      })),
      merge_config: Type.Optional(Type.Object({
        new_tentacle_id: Type.String(),
        new_purpose: Type.String(),
        preferred_runtime: Type.Optional(Type.String()),
      })),
    }),
    async execute(_id, params: any) {
      const results: string[] = []

      if (params.action === "strengthen") {
        if (!lifecycleManager) return ok("Error: lifecycle manager not available")
        for (const tentacleId of params.tentacle_ids as string[]) {
          try {
            const cfg: StrengthenConfig = {
              newFrequency: params.strengthen_config?.new_frequency,
              additionalCapabilities: params.strengthen_config?.additional_capabilities,
              upgradeDescription: params.strengthen_config?.upgrade_description,
            }
            await lifecycleManager.strengthen(tentacleId, cfg)
            results.push(`${tentacleId}: strengthened`)
          } catch (error: any) {
            results.push(`${tentacleId}: error — ${error.message}`)
          }
        }
        return ok(results.join("\n"))
      }

      if (params.action === "merge") {
        if (!lifecycleManager) return ok("Error: lifecycle manager not available")
        if (!params.merge_config?.new_tentacle_id || !params.merge_config?.new_purpose) {
          return ok("Error: merge_config with new_tentacle_id and new_purpose is required")
        }
        if ((params.tentacle_ids as string[]).length < 2) {
          return ok("Error: merge requires at least 2 tentacle_ids")
        }
        try {
          const cfg: MergeConfig = {
            newTentacleId: params.merge_config.new_tentacle_id,
            newPurpose: params.merge_config.new_purpose,
            preferredRuntime: params.merge_config.preferred_runtime,
          }
          const result = await lifecycleManager.merge(params.tentacle_ids, cfg)
          return ok(JSON.stringify({ success: true, ...result }, null, 2))
        } catch (error: any) {
          return ok(`Error: ${error.message}`)
        }
      }

      for (const tentacleId of params.tentacle_ids as string[]) {
        let success = false
        if (params.action === "pause") success = await manager.pause(tentacleId)
        if (params.action === "resume") success = await manager.resume(tentacleId)
        if (params.action === "weaken") {
          if (lifecycleManager) {
            try {
              await lifecycleManager.weaken(tentacleId, { newFrequency: params.weaken_config?.new_frequency })
              success = true
            } catch {
              success = false
            }
          } else {
            success = await manager.weaken(tentacleId, params.reason ?? "tool_request")
          }
        }
        if (params.action === "kill") success = await manager.kill(tentacleId, params.reason ?? "tool_request")
        if (params.action === "run_now") success = await manager.runNow(tentacleId)
        results.push(`${tentacleId}: ${success ? "ok" : "failed"}`)
      }
      return ok(results.join("\n"))
    },
  }

  const manageTentacleSchedule: ToolDefinition = {
    name: "manage_tentacle_schedule",
    label: "Manage Tentacle Schedule",
    description: "管理触手的 cron、heartbeat 和自管频率",
    parameters: Type.Object({
      tentacle_id: Type.String(),
      action: Type.Union([
        Type.Literal("set_tentacle_cron"),
        Type.Literal("remove_tentacle_cron"),
        Type.Literal("set_tentacle_heartbeat"),
        Type.Literal("disable_tentacle_heartbeat"),
        Type.Literal("set_self_schedule"),
        Type.Literal("update_self_schedule_config"),
        Type.Literal("get_schedule"),
      ]),
      cron_config: Type.Optional(Type.Object({
        expr: Type.String(),
        tz: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
      })),
      cron_job_id: Type.Optional(Type.String()),
      heartbeat_config: Type.Optional(Type.Object({
        every: Type.String(),
        prompt: Type.Optional(Type.String()),
      })),
      self_schedule_config: Type.Optional(Type.Object({
        interval: Type.String(),
      })),
    }),
    async execute(_id, params: any) {
      const action = normalizeScheduleAction(params.action)
      const current = (await manager.getTentacleSchedule(params.tentacle_id)) ?? {
        primaryTrigger: { type: "self-schedule", interval: "6h" },
        cronJobs: [],
      } satisfies TentacleScheduleConfig

      if (action === "get_schedule") {
        return ok(JSON.stringify(current, null, 2))
      }

      if (action === "set_tentacle_cron") {
        if (!params.cron_config?.expr) return ok("Error: cron_config.expr is required")
        const slug = (params.cron_config.name ?? "cron").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
        const jobId = `tc-${params.tentacle_id}-${slug || "run"}`
        const scheduler = manager.getCronScheduler()
        if (!scheduler) return ok("Error: cron scheduler not ready")
        await scheduler.addJob({
          jobId,
          name: `${params.tentacle_id} ${params.cron_config.name ?? "cron"}`,
          schedule: { kind: "cron", expr: params.cron_config.expr, tz: params.cron_config.tz },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Trigger tentacle fetch cycle" },
          tentacleId: params.tentacle_id,
        })
        await manager.setTentacleSchedule(params.tentacle_id, {
          ...current,
          primaryTrigger: { type: "cron", jobId },
          cronJobs: Array.from(new Set([...(current.cronJobs ?? []), jobId])),
        })
        return ok(`Tentacle cron created: ${jobId}`)
      }

      if (action === "remove_tentacle_cron") {
        const scheduler = manager.getCronScheduler()
        if (!scheduler || !params.cron_job_id) return ok("Error: cron_job_id is required")
        await scheduler.removeJob(params.cron_job_id)
        await manager.setTentacleSchedule(params.tentacle_id, {
          ...current,
          cronJobs: (current.cronJobs ?? []).filter((id) => id !== params.cron_job_id),
          primaryTrigger: current.primaryTrigger.type === "cron" && current.primaryTrigger.jobId === params.cron_job_id
            ? { type: "self-schedule", interval: "6h" }
            : current.primaryTrigger,
        })
        return ok(`Tentacle cron removed: ${params.cron_job_id}`)
      }

      if (action === "set_tentacle_heartbeat") {
        if (!params.heartbeat_config?.every) return ok("Error: heartbeat_config.every is required")
        const scheduler = manager.getCronScheduler()
        if (!scheduler) return ok("Error: cron scheduler not ready")
        const jobId = `thb-${params.tentacle_id}`
        const normalizedEvery = normalizeDurationInput(params.heartbeat_config.every)
        const everyMs = await import("../cron/time.js").then((m) => m.parseDurationMs(normalizedEvery))
        const existing = scheduler.listJobs().find((job: any) => job.jobId === jobId)
        if (existing) {
          await scheduler.updateJob(jobId, {
            schedule: { kind: "every", everyMs },
            payload: { kind: "agentTurn", message: params.heartbeat_config.prompt ?? "Review recent findings and suggest strategy adjustments." },
          })
        } else {
          await scheduler.addJob({
            jobId,
            name: `${params.tentacle_id} heartbeat`,
            schedule: { kind: "every", everyMs },
            sessionTarget: "isolated",
            payload: { kind: "agentTurn", message: params.heartbeat_config.prompt ?? "Review recent findings and suggest strategy adjustments." },
            tentacleId: params.tentacle_id,
          })
        }
        await manager.setTentacleSchedule(params.tentacle_id, {
          ...current,
          heartbeat: {
            enabled: true,
            every: normalizedEvery,
            prompt: params.heartbeat_config.prompt ?? "Review recent findings and suggest strategy adjustments.",
            jobId,
          },
        })
        return ok(`Tentacle heartbeat enabled: ${jobId}`)
      }

      if (action === "disable_tentacle_heartbeat") {
        const scheduler = manager.getCronScheduler()
        const jobId = current.heartbeat?.jobId ?? `thb-${params.tentacle_id}`
        if (scheduler) {
          await scheduler.removeJob(jobId)
        }
        await manager.setTentacleSchedule(params.tentacle_id, {
          ...current,
          heartbeat: current.heartbeat ? { ...current.heartbeat, enabled: false, jobId: undefined } : undefined,
        })
        return ok(`Tentacle heartbeat disabled: ${jobId}`)
      }

      if (action === "set_self_schedule") {
        if (!params.self_schedule_config?.interval) return ok("Error: self_schedule_config.interval is required")
        const normalizedInterval = normalizeDurationInput(params.self_schedule_config.interval)
        const scheduler = manager.getCronScheduler()
        if (scheduler) {
          for (const jobId of current.cronJobs ?? []) {
            await scheduler.removeJob(jobId)
          }
          if (current.heartbeat?.jobId) {
            await scheduler.removeJob(current.heartbeat.jobId)
          }
        }
        await manager.setTentacleSchedule(params.tentacle_id, {
          primaryTrigger: { type: "self-schedule", interval: normalizedInterval },
          cronJobs: [],
        })
        return ok(`Tentacle self schedule set: ${normalizedInterval}`)
      }

      return ok("Unsupported action")
    },
  }

  const inspectTentacleLog: ToolDefinition = {
    name: "inspect_tentacle_log",
    label: "Inspect Tentacle Log",
    description: "查看触手的运行日志。触手出问题时优先用这个看具体错误，比 web_search 有用得多。",
    parameters: Type.Object({
      tentacle_id: Type.String(),
      n_lines: Type.Optional(Type.Number({ default: 50 })),
      event_filter: Type.Optional(Type.String()),
    }),
    async execute(_id, params: any) {
      try {
        const artifacts = await resolveTentacleArtifacts(manager, logDir, params.tentacle_id)
        const terminalTail = await tailTextFile(artifacts.terminalLog, params.n_lines ?? 50)
        let eventsTail = artifacts.eventsLog ? await tailTextFile(artifacts.eventsLog, params.n_lines ?? 50) : ""
        if (params.event_filter && eventsTail) {
          eventsTail = eventsTail
            .split("\n")
            .filter((line) => line.includes(params.event_filter))
            .join("\n")
        }
        return ok([
          `tentacle_id=${params.tentacle_id}`,
          `directory=${artifacts.tentacleDir}`,
          `log_dir=${artifacts.logsDir}`,
          `terminal_log=${artifacts.terminalLog}`,
          `stdout_log=${artifacts.stdoutLog}`,
          `stderr_log=${artifacts.stderrLog}`,
          `events_log=${artifacts.eventsLog ?? "-"}`,
          `data_paths=${artifacts.dataPaths.length > 0 ? artifacts.dataPaths.join(", ") : "-"}`,
          "",
          "[recent_terminal_output]",
          terminalTail || "(empty)",
          "",
          "[recent_events_log]",
          eventsTail || "(empty)",
        ].join("\n"))
      } catch (error: any) {
        return ok(`Error: ${error.message}`)
      }
    },
  }

  // M3+M4: Unified spawn_from_skill — works with skill_tentacle, legacy SKILL blueprint, or from scratch
  const spawnFromSkill: ToolDefinition = {
    name: "spawn_from_skill",
    label: "Spawn Tentacle",
    description: "创建并部署新的触手 Agent 系统。deploy 模式直接部署（不生成代码）；customize 模式基于已有 SKILL 修改逻辑；create 模式从零生成。",
    parameters: Type.Object({
      // ── 结构化字段（代码层必须用的硬信息）──
      tentacle_id: Type.String({
        description: "新触手 ID，格式 t_{简短英文标识}，如 t_hn_radar、t_arxiv_scout",
      }),
      skill_name: Type.Optional(Type.String({
        description: "匹配的 SKILL 名称。场景 A/B 必填，场景 C 不填。",
      })),
      mode: Type.Union([
        Type.Literal("deploy"),
        Type.Literal("customize"),
        Type.Literal("create"),
      ], {
        description: `部署模式——你需要自己判断：
      deploy: 有现成 SKILL，代码不用改，只需要调配置。大多数内置触手部署用这个。
      customize: 有现成 SKILL 但用户要改代码逻辑（加功能、改算法、换数据源）。
      create: 没有匹配的 SKILL，需要从零开始。`,
      }),
      purpose: Type.String({
        description: "触手的使命，一句话说清楚它是干什么的。",
      }),
      config: Type.Optional(Type.Record(Type.String(), Type.String(), {
        description: "配置参数，key 对应 SKILL.md 中 customizable 字段的 env_var 名称。场景 A 用这个传用户偏好。",
      })),

      // ── 自由文本字段（Brain 写给 Claude Code 的需求描述）──
      brief: Type.Optional(Type.String({
        description: `场景 B/C 的需求描述。你用自然语言写，像给一个工程师交代任务一样。
      应该包含：用户是谁、想要什么、数据源是什么、触发频率、特殊要求。
      场景 A 不需要填（配置通过 config 字段传递）。
      场景 B 要说清楚在现有 SKILL 基础上改什么。
      场景 C 要完整描述触手的使命和工作方式。`,
      })),

      preferred_runtime: Type.Optional(Type.String({ default: "auto" })),

      // M4 additions
      skill_tentacle_path: Type.Optional(Type.String({
        description: "直接指向本地 skill_tentacle 目录或 .tentacle 文件路径，跳过 skill 搜索",
      })),
      package_after: Type.Optional(Type.Boolean({
        description: "场景 C 完成后是否打包为可分享的 skill_tentacle",
        default: false,
      })),
    }),
    async execute(_id, params: any) {
      try {
        brainLogger.info("skill_spawn_start", {
          tentacle_id: params.tentacle_id,
          skill_name: params.skill_name ?? "none",
          mode: params.mode,
          purpose: params.purpose,
        })
        const spawnParams: SpawnParams = {
          mode: params.mode,
          skillName: params.skill_name,
          tentacleId: params.tentacle_id,
          purpose: params.purpose,
          preferredRuntime: params.preferred_runtime ?? "auto",
          userConfirmed: true,
          skillTentaclePath: params.skill_tentacle_path,
          packageAfter: params.package_after,
          config: params.config,
          brief: params.brief,
        }
        const result = await skillSpawner.spawn(spawnParams)
        if (result.success) {
          const rendered = {
            ...result,
            runtime_status: result.spawned ? "running" : "not_running",
            requires_explicit_run_confirmation: !result.spawned,
            next_step: result.spawned
              ? "触手已通过 spawn + registration 确认运行。"
              : "触手目前未运行；如需运行，必须继续检查 spawned/running 状态或显式执行启动动作。",
          }
          brainLogger.info("skill_spawn_success", {
            tentacle_id: params.tentacle_id,
            runtime: result.runtime,
            pid: result.pid,
            files: result.files,
            code_agent_session_file: result.codeAgentSessionFile,
            code_agent_work_dir: result.codeAgentWorkDir,
          })
          brainLogger.info("tentacle_creator_user_review", {
            tentacle_id: params.tentacle_id,
            spawned: result.spawned,
            deployed: result.deployed,
            package_path: result.packagePath,
            source: result.source,
          })
          return ok(JSON.stringify(rendered, null, 2))
        }
        brainLogger.error("skill_spawn_failed", {
          tentacle_id: params.tentacle_id,
          errors: result.errors,
          code_agent_session_file: result.codeAgentSessionFile,
          code_agent_work_dir: result.codeAgentWorkDir,
        })
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          isError: true,
          details: undefined,
        }
      } catch (error: any) {
        brainLogger.error("skill_spawn_exception", {
          tentacle_id: params.tentacle_id,
          error: error.message,
          stack: error.stack,
        })
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
          details: undefined,
        }
      }
    },
  }

  // M3: Review all tentacles and get recommended actions
  const reviewTentacles: ToolDefinition = {
    name: "review_tentacles",
    label: "Review Tentacles",
    description: "复盘所有活跃触手，基于健康度评分返回 weaken/kill/merge/strengthen 建议",
    parameters: Type.Object({}),
    async execute() {
      if (!reviewEngine) return ok("Error: review engine not available")
      try {
        const actions = await reviewEngine.review()
        if (actions.length === 0) return ok("No actions recommended — all tentacles healthy.")
        const actionable = actions.filter((a) => a.action !== "none")
        if (actionable.length === 0) return ok("No actions recommended — all tentacles healthy.")
        return ok(actionable.map((a) =>
          `${a.tentacleId}: ${a.action}${a.mergeWith ? ` (with ${a.mergeWith})` : ""}\n  reason: ${a.reason}\n  confidence: ${a.confidence.toFixed(2)}\n  requires_confirm: ${a.requiresUserConfirm}`
        ).join("\n\n"))
      } catch (error: any) {
        return ok(`Error: ${error.message}`)
      }
    },
  }

  return [
    { name: "list_tentacles", description: listTentacles.description, group: "tentacle", tool: listTentacles },
    { name: "manage_tentacle", description: manageTentacle.description, group: "tentacle", tool: manageTentacle },
    { name: "manage_tentacle_schedule", description: manageTentacleSchedule.description, group: "tentacle", tool: manageTentacleSchedule },
    { name: "inspect_tentacle_log", description: inspectTentacleLog.description, group: "tentacle", tool: inspectTentacleLog },
    { name: "spawn_from_skill", description: spawnFromSkill.description, group: "tentacle", tool: spawnFromSkill },
    { name: "review_tentacles", description: reviewTentacles.description, group: "tentacle", tool: reviewTentacles },
  ]
}
