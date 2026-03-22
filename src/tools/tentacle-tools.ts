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

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined }
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
    description: "列出所有触手及其状态",
    parameters: Type.Object({
      status_filter: Type.Optional(Type.Union([
        Type.Literal("all"),
        Type.Literal("running"),
        Type.Literal("paused"),
        Type.Literal("killed"),
        Type.Literal("crashed"),
      ])),
    }),
    async execute(_id, params: any) {
      const items = manager.listAll({ status: params.status_filter ?? "all" })
      if (items.length === 0) return ok("No tentacles found.")
      return ok(items.map((item) =>
        `${item.tentacleId}\nstatus=${item.status}\npid=${item.pid ?? "-"}\npurpose=${item.purpose ?? "-"}\ntrigger=${item.triggerSchedule ?? "-"}\nheartbeat=${item.scheduleConfig?.heartbeat?.enabled ? item.scheduleConfig.heartbeat.every : "off"}\ncron_jobs=${item.scheduleConfig?.cronJobs?.length ?? 0}`
      ).join("\n\n"))
    },
  }

  const manageTentacle: ToolDefinition = {
    name: "manage_tentacle",
    label: "Manage Tentacle",
    description: "暂停、恢复、关闭、削弱、增强、合并或立即触发触手",
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
      const current = (await manager.getTentacleSchedule(params.tentacle_id)) ?? {
        primaryTrigger: { type: "self-schedule", interval: "6h" },
        cronJobs: [],
      } satisfies TentacleScheduleConfig

      if (params.action === "get_schedule") {
        return ok(JSON.stringify(current, null, 2))
      }

      if (params.action === "set_tentacle_cron") {
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

      if (params.action === "remove_tentacle_cron") {
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

      if (params.action === "set_tentacle_heartbeat") {
        if (!params.heartbeat_config?.every) return ok("Error: heartbeat_config.every is required")
        const scheduler = manager.getCronScheduler()
        if (!scheduler) return ok("Error: cron scheduler not ready")
        const jobId = `thb-${params.tentacle_id}`
        const everyMs = await import("../cron/time.js").then((m) => m.parseDurationMs(params.heartbeat_config.every))
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
            every: params.heartbeat_config.every,
            prompt: params.heartbeat_config.prompt ?? "Review recent findings and suggest strategy adjustments.",
            jobId,
          },
        })
        return ok(`Tentacle heartbeat enabled: ${jobId}`)
      }

      if (params.action === "disable_tentacle_heartbeat") {
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

      if (params.action === "set_self_schedule") {
        if (!params.self_schedule_config?.interval) return ok("Error: self_schedule_config.interval is required")
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
          primaryTrigger: { type: "self-schedule", interval: params.self_schedule_config.interval },
          cronJobs: [],
        })
        return ok(`Tentacle self schedule set: ${params.self_schedule_config.interval}`)
      }

      return ok("Unsupported action")
    },
  }

  const inspectTentacleLog: ToolDefinition = {
    name: "inspect_tentacle_log",
    label: "Inspect Tentacle Log",
    description: "查看触手日志尾部内容",
    parameters: Type.Object({
      tentacle_id: Type.String(),
      n_lines: Type.Optional(Type.Number({ default: 50 })),
      event_filter: Type.Optional(Type.String()),
    }),
    async execute(_id, params: any) {
      try {
        const files = (await fs.readdir(logDir))
          .filter((file) => file.startsWith(`tentacle-${params.tentacle_id}-`))
          .sort()
        const file = files.at(-1)
        if (!file) return ok(`No log file found for ${params.tentacle_id}`)
        const content = await fs.readFile(path.join(logDir, file), "utf-8")
        let lines = content.trim().split("\n")
        if (params.event_filter) {
          lines = lines.filter((line) => line.includes(params.event_filter))
        }
        return ok(lines.slice(-(params.n_lines ?? 50)).join("\n"))
      } catch (error: any) {
        return ok(`Error: ${error.message}`)
      }
    },
  }

  // M3+M4: Unified spawn_from_skill — works with skill_tentacle, legacy SKILL blueprint, or from scratch
  const spawnFromSkill: ToolDefinition = {
    name: "spawn_from_skill",
    label: "Spawn Tentacle",
    description: "创建并部署新的触手 Agent 系统。skill_tentacle 直接部署（不生成代码）；有 SKILL 蓝图时作为 context 定制生成；无 SKILL 时按 skill_tentacle 规范从零生成。",
    parameters: Type.Object({
      skill_name: Type.Optional(Type.String({ description: "SKILL 名称。有值时走场景一（部署已有 skill_tentacle）或兼容旧式 SKILL；无值时走场景二（从零生成）" })),
      tentacle_id: Type.String({ description: "触手 ID，格式 t_{slug}" }),
      purpose: Type.String({ description: "触手使命（一句话）" }),
      workflow: Type.String({ description: "工作流描述（自然语言）" }),
      capabilities: Type.Optional(Type.Array(Type.String())),
      report_strategy: Type.Optional(Type.String({ description: "什么情况下上报大脑" })),
      infrastructure: Type.Optional(Type.Object({
        needsHttpServer: Type.Optional(Type.Boolean()),
        needsDatabase: Type.Optional(Type.Boolean()),
        needsExternalBot: Type.Optional(Type.Object({
          platform: Type.String(),
          purpose: Type.String(),
        })),
        needsLlm: Type.Optional(Type.Boolean()),
        needsFileStorage: Type.Optional(Type.Boolean()),
      })),
      external_apis: Type.Optional(Type.Array(Type.String())),
      preferred_runtime: Type.Optional(Type.String({ default: "auto" })),
      ask_user_confirm: Type.Optional(Type.Boolean({ default: true })),
      // M4 additions
      skill_tentacle_path: Type.Optional(Type.String({
        description: "直接指向本地 skill_tentacle 目录或 .tentacle 文件路径，跳过 skill 搜索",
      })),
      package_after: Type.Optional(Type.Boolean({
        description: "场景二完成后是否打包为可分享的 skill_tentacle",
        default: false,
      })),
      config: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: "用户个性化配置（场景一时传入 customizable 字段值）",
      })),
    }),
    async execute(_id, params: any) {
      void params.ask_user_confirm
      try {
        brainLogger.info("skill_spawn_start", {
          tentacle_id: params.tentacle_id,
          skill_name: params.skill_name ?? "none",
          purpose: params.purpose,
        })
        const spawnParams: SpawnParams = {
          skillName: params.skill_name,
          tentacleId: params.tentacle_id,
          purpose: params.purpose,
          workflow: params.workflow,
          capabilities: params.capabilities,
          reportStrategy: params.report_strategy,
          infrastructure: params.infrastructure,
          externalApis: params.external_apis,
          preferredRuntime: params.preferred_runtime ?? "auto",
          userConfirmed: true,
          skillTentaclePath: params.skill_tentacle_path,
          packageAfter: params.package_after,
          config: params.config,
        }
        const result = await skillSpawner.spawn(spawnParams)
        if (result.success) {
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
          return ok(JSON.stringify(result, null, 2))
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
