import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { ToolRegistryEntry } from "./index.js"
import { HeartbeatTaskManager } from "../heartbeat/task-manager.js"

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined }
}

export function createHeartbeatTools(workspaceDir: string): ToolRegistryEntry[] {
  const manager = new HeartbeatTaskManager(workspaceDir)

  const createHeartbeatTask: ToolDefinition = {
    name: "create_heartbeat_task",
    label: "Create Heartbeat Task",
    description: "向 HEARTBEAT.md 添加待处理任务",
    parameters: Type.Object({
      task: Type.String({ description: "任务描述" }),
      schedule: Type.Union([
        Type.Literal("daily"),
        Type.Literal("weekly"),
        Type.Literal("once"),
      ]),
      section: Type.Optional(Type.Union([
        Type.Literal("每日必做"),
        Type.Literal("每周任务"),
        Type.Literal("待处理"),
      ])),
    }),
    async execute(_id, params: any) {
      await manager.addTask(params.task, params.schedule, params.section)
      return ok(`Heartbeat task created: ${params.task}`)
    },
  }

  const completeHeartbeatTask: ToolDefinition = {
    name: "complete_heartbeat_task",
    label: "Complete Heartbeat Task",
    description: "将 HEARTBEAT.md 中的任务标记为完成",
    parameters: Type.Object({
      task_description: Type.String({ description: "任务描述，需与 HEARTBEAT.md 中任务一致" }),
      notes: Type.Optional(Type.String()),
    }),
    async execute(_id, params: any) {
      try {
        await manager.completeTask(params.task_description, params.notes)
        return ok(`Heartbeat task completed: ${params.task_description}`)
      } catch (error: any) {
        return ok(`Error: ${error.message}`)
      }
    },
  }

  return [
    { name: "create_heartbeat_task", description: createHeartbeatTask.description, group: "heartbeat", tool: createHeartbeatTask },
    { name: "complete_heartbeat_task", description: completeHeartbeatTask.description, group: "heartbeat", tool: completeHeartbeatTask },
  ]
}
