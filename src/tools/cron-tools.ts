import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { ToolRegistryEntry } from "./index.js"
import type { CronScheduler } from "../cron/cron-scheduler.js"
import { parseDurationMs } from "../cron/time.js"

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined }
}

export function createCronTools(cronScheduler: CronScheduler): ToolRegistryEntry[] {
  const scheduleSchema = Type.Object({
    kind: Type.Union([Type.Literal("at"), Type.Literal("every"), Type.Literal("cron")]),
    at: Type.Optional(Type.String()),
    everyMs: Type.Optional(Type.Number()),
    expr: Type.Optional(Type.String()),
    tz: Type.Optional(Type.String()),
  })

  const deliverySchema = Type.Optional(Type.Object({
    mode: Type.Union([Type.Literal("announce"), Type.Literal("none")], { default: "announce" }),
    channel: Type.Optional(Type.String({ default: "last" })),
  }))

  const cronAdd: ToolDefinition = {
    name: "cron_add",
    label: "Cron Add",
    description: "创建定时任务",
    parameters: Type.Object({
      name: Type.String(),
      schedule: scheduleSchema,
      sessionTarget: Type.Union([Type.Literal("main"), Type.Literal("isolated")], { default: "isolated" }),
      message: Type.String(),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
      delivery: deliverySchema,
      deleteAfterRun: Type.Optional(Type.Boolean({ default: false })),
      tentacleId: Type.Optional(Type.String()),
    }),
    async execute(_id, params: any) {
      const payload = params.sessionTarget === "main"
        ? { kind: "systemEvent" as const, text: params.message }
        : { kind: "agentTurn" as const, message: params.message }
      const job = await cronScheduler.addJob({
        name: params.name,
        schedule: params.schedule,
        sessionTarget: params.sessionTarget,
        payload,
        model: params.model,
        thinking: params.thinking,
        delivery: params.delivery,
        deleteAfterRun: params.deleteAfterRun,
        tentacleId: params.tentacleId,
      })
      return ok(`Cron job created: ${job.jobId}`)
    },
  }

  const cronList: ToolDefinition = {
    name: "cron_list",
    label: "Cron List",
    description: "列出所有定时任务",
    parameters: Type.Object({
      enabled_only: Type.Optional(Type.Boolean({ default: false })),
      tentacle_id: Type.Optional(Type.String()),
    }),
    async execute(_id, params: any) {
      const jobs = cronScheduler.listJobs({ enabled: params.enabled_only ? true : undefined })
        .filter((job) => !params.tentacle_id || job.tentacleId === params.tentacle_id)
      if (jobs.length === 0) return ok("No cron jobs found.")
      return ok(jobs.map((job) =>
        `${job.jobId} | ${job.enabled ? "enabled" : "disabled"} | ${job.sessionTarget} | next=${job.nextRunAt ?? "-"} | ${job.name}`
      ).join("\n"))
    },
  }

  const cronUpdate: ToolDefinition = {
    name: "cron_update",
    label: "Cron Update",
    description: "修改定时任务",
    parameters: Type.Object({
      job_id: Type.String(),
      patch: Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        schedule: Type.Optional(scheduleSchema),
        message: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        delivery: deliverySchema,
      }),
    }),
    async execute(_id, params: any) {
      const current = cronScheduler.listJobs().find((job) => job.jobId === params.job_id)
      if (!current) return ok(`Error: Cron job not found: ${params.job_id}`)
      const patch: any = { ...params.patch }
      if (patch.message) {
        patch.payload = current.sessionTarget === "main"
          ? { kind: "systemEvent", text: patch.message }
          : { kind: "agentTurn", message: patch.message }
        delete patch.message
      }
      const job = await cronScheduler.updateJob(params.job_id, patch)
      return ok(`Cron job updated: ${job.jobId}`)
    },
  }

  const cronRemove: ToolDefinition = {
    name: "cron_remove",
    label: "Cron Remove",
    description: "删除定时任务",
    parameters: Type.Object({
      job_id: Type.String(),
    }),
    async execute(_id, params: any) {
      const removed = await cronScheduler.removeJob(params.job_id)
      return ok(removed ? `Cron job removed: ${params.job_id}` : `Cron job not found: ${params.job_id}`)
    },
  }

  const cronRun: ToolDefinition = {
    name: "cron_run",
    label: "Cron Run",
    description: "手动触发定时任务",
    parameters: Type.Object({
      job_id: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal("force"), Type.Literal("due")], { default: "force" })),
    }),
    async execute(_id, params: any) {
      await cronScheduler.runJob(params.job_id, params.mode ?? "force")
      return ok(`Cron job triggered: ${params.job_id}`)
    },
  }

  void parseDurationMs
  return [
    { name: "cron_add", description: cronAdd.description, group: "cron", tool: cronAdd },
    { name: "cron_list", description: cronList.description, group: "cron", tool: cronList },
    { name: "cron_update", description: cronUpdate.description, group: "cron", tool: cronUpdate },
    { name: "cron_remove", description: cronRemove.description, group: "cron", tool: cronRemove },
    { name: "cron_run", description: cronRun.description, group: "cron", tool: cronRun },
  ]
}
