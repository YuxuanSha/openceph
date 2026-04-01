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
    description: "Add a pending task to HEARTBEAT.md",
    parameters: Type.Object({
      task: Type.String({ description: "Task description" }),
      schedule: Type.Union([
        Type.Literal("daily"),
        Type.Literal("weekly"),
        Type.Literal("once"),
      ]),
      section: Type.Optional(Type.Union([
        Type.Literal("Daily Tasks"),
        Type.Literal("Weekly Tasks"),
        Type.Literal("Pending"),
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
    description: "Mark a task in HEARTBEAT.md as completed",
    parameters: Type.Object({
      task_description: Type.String({ description: "Task description — must match the task in HEARTBEAT.md exactly" }),
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
