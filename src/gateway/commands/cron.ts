import type { CommandExecutor, CommandContext } from "./command-handler.js"
import { CronStore } from "../../cron/cron-store.js"
import * as path from "path"
import * as os from "os"

function getStore() {
  return new CronStore(path.join(os.homedir(), ".openceph", "cron", "jobs.json"))
}

export const cronCommand: CommandExecutor = {
  async execute(args: string[], ctx: CommandContext): Promise<string> {
    const sub = args[0] ?? "list"
    const store = getStore()
    const jobs = await store.loadAll()

    if (sub === "list") {
      if (jobs.length === 0) return "No cron jobs."
      return jobs.map((job) =>
        `${job.jobId} | ${job.enabled ? "enabled" : "disabled"} | ${job.sessionTarget} | next=${job.nextRunAt ?? "-"} | ${job.name}`
      ).join("\n")
    }

    if (sub === "status") {
      const jobId = args[1]
      if (!jobId) return "Usage: /cron status <jobId>"
      const job = jobs.find((item) => item.jobId === jobId)
      if (!job) return `Cron job not found: ${jobId}`
      const runs = await store.getRunEntries(jobId, 5)
      return [
        `${job.jobId} | ${job.name}`,
        `enabled=${job.enabled} session=${job.sessionTarget} next=${job.nextRunAt ?? "-"}`,
        `schedule=${JSON.stringify(job.schedule)}`,
        `recent_runs=${runs.length === 0 ? "none" : ""}`,
        ...runs.map((run) => `- ${run.startedAt} ${run.status}${run.error ? ` ${run.error}` : ""}`),
      ].join("\n")
    }

    if (sub === "run") {
      const jobId = args[1]
      if (!jobId) return "Usage: /cron run <jobId>"
      await ctx.brain.runCronJob(jobId)
      return `Triggered cron job: ${jobId}`
    }

    return "Usage: /cron [list|status|run]"
  },
}
