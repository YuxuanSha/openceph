import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import * as fs from "fs/promises"
import * as path from "path"
import type { ToolRegistryEntry } from "./index.js"
import { TentacleManager } from "../tentacle/manager.js"
import { SkillSpawner } from "../skills/skill-spawner.js"

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined }
}

export function createTentacleTools(
  manager: TentacleManager,
  logDir: string,
  skillSpawner: SkillSpawner,
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
        `${item.tentacleId}\nstatus=${item.status}\npid=${item.pid ?? "-"}\npurpose=${item.purpose ?? "-"}`
      ).join("\n\n"))
    },
  }

  const manageTentacle: ToolDefinition = {
    name: "manage_tentacle",
    label: "Manage Tentacle",
    description: "暂停、恢复、关闭或立即触发触手",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("kill"),
        Type.Literal("run_now"),
      ]),
      tentacle_ids: Type.Array(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params: any) {
      const results: string[] = []
      for (const tentacleId of params.tentacle_ids as string[]) {
        let success = false
        if (params.action === "pause") success = await manager.pause(tentacleId)
        if (params.action === "resume") success = await manager.resume(tentacleId)
        if (params.action === "kill") success = await manager.kill(tentacleId, params.reason ?? "tool_request")
        if (params.action === "run_now") success = await manager.runNow(tentacleId)
        results.push(`${tentacleId}: ${success ? "ok" : "failed"}`)
      }
      return ok(results.join("\n"))
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

  const spawnFromSkill: ToolDefinition = {
    name: "spawn_from_skill",
    label: "Spawn From Skill",
    description: "从 SKILL 孵化新的触手",
    parameters: Type.Object({
      skill_name: Type.String(),
      tentacle_id: Type.String(),
      trigger_override: Type.Optional(Type.String()),
      config: Type.Optional(Type.Object({}, { additionalProperties: true })),
      ask_user_confirm: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_id, params: any) {
      void params.ask_user_confirm
      try {
        const result = await skillSpawner.spawn(
          params.skill_name,
          params.tentacle_id,
          params.trigger_override,
          params.config,
        )
        return ok(JSON.stringify({ success: true, ...result }, null, 2))
      } catch (error: any) {
        return ok(`Error: ${error.message}`)
      }
    },
  }

  return [
    { name: "list_tentacles", description: listTentacles.description, group: "tentacle", tool: listTentacles },
    { name: "manage_tentacle", description: manageTentacle.description, group: "tentacle", tool: manageTentacle },
    { name: "inspect_tentacle_log", description: inspectTentacleLog.description, group: "tentacle", tool: inspectTentacleLog },
    { name: "spawn_from_skill", description: spawnFromSkill.description, group: "tentacle", tool: spawnFromSkill },
  ]
}
