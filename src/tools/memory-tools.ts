import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import { MemoryManager } from "../memory/memory-manager.js"
import { MemoryDistiller } from "../memory/memory-distiller.js"
import { brainLogger } from "../logger/index.js"
import type { ToolRegistryEntry } from "./index.js"
import type { PiContext } from "../pi/pi-context.js"
import type { OpenCephConfig } from "../config/config-schema.js"

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined }
}

function createMemoryTools(options: {
  workspaceDir: string
  piCtx?: PiContext
  config?: OpenCephConfig
}): ToolRegistryEntry[] {
  const { workspaceDir, piCtx, config } = options
  const mm = new MemoryManager(workspaceDir)
  const distiller = piCtx && config ? new MemoryDistiller(piCtx, config) : undefined

  const readMemory: ToolDefinition = {
    name: "read_memory",
    label: "Read Memory",
    description: "读取 MEMORY.md 的指定 section 或全文",
    promptSnippet: "read_memory — 读取 MEMORY.md 或搜索记忆内容",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "搜索关键词，不传返回全文" })),
      section: Type.Optional(Type.String({ description: "指定读取的 section 名" })),
    }),
    async execute(_id, params: any) {
      const content = await mm.readMemory(params.section, params.query)
      return ok(content)
    },
  }

  const writeMemory: ToolDefinition = {
    name: "write_memory",
    label: "Write Memory",
    description: "写入记忆到每日日志 memory/YYYY-MM-DD.md",
    promptSnippet: "write_memory — 写入新记忆到每日日志",
    parameters: Type.Object({
      content: Type.String({ description: "要写入的记忆内容" }),
      section: Type.String({ description: "目标 section" }),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params: any) {
      const memoryId = await mm.writeMemory(params.content, params.section, params.tags)
      brainLogger.info("memory_write", { memory_id: memoryId, section: params.section })
      return ok(`Memory written. ID: ${memoryId}`)
    },
  }

  const updateMemory: ToolDefinition = {
    name: "update_memory",
    label: "Update Memory",
    description: "更新已有记忆条目",
    promptSnippet: "update_memory — 更新已有记忆条目",
    parameters: Type.Object({
      memory_id: Type.String({ description: "记忆 ID，格式：YYYY-MM-DD-NNN" }),
      content: Type.String({ description: "新内容" }),
    }),
    async execute(_id, params: any) {
      try {
        await mm.updateMemory(params.memory_id, params.content)
        brainLogger.info("memory_update", { memory_id: params.memory_id })
        return ok(`Memory ${params.memory_id} updated.`)
      } catch (err: any) {
        return ok(`Error: ${err.message}`)
      }
    },
  }

  const deleteMemory: ToolDefinition = {
    name: "delete_memory",
    label: "Delete Memory",
    description: "删除指定记忆条目",
    promptSnippet: "delete_memory — 删除指定记忆条目",
    parameters: Type.Object({
      memory_id: Type.String(),
    }),
    async execute(_id, params: any) {
      try {
        await mm.deleteMemory(params.memory_id)
        brainLogger.info("memory_delete", { memory_id: params.memory_id })
        return ok(`Memory ${params.memory_id} deleted.`)
      } catch (err: any) {
        return ok(`Error: ${err.message}`)
      }
    },
  }

  const memoryGet: ToolDefinition = {
    name: "memory_get",
    label: "Get Memory File",
    description: "读取指定 memory 文件",
    promptSnippet: "memory_get — 读取指定 memory 文件内容",
    parameters: Type.Object({
      path: Type.String({ description: "memory 文件路径，如 2026-03-19.md" }),
      line_range: Type.Optional(Type.Object({
        start: Type.Number(),
        end: Type.Number(),
      })),
    }),
    async execute(_id, params: any) {
      try {
        const content = await mm.getMemoryFile(params.path, params.line_range)
        return ok(content)
      } catch (err: any) {
        return ok(`Error: ${err.message}`)
      }
    },
  }

  const memorySearch: ToolDefinition = {
    name: "memory_search",
    label: "Search Memory",
    description: "搜索 MEMORY.md 和 memory/ 日志中的相关记忆",
    promptSnippet: "memory_search — 搜索长期记忆与每日记忆日志",
    parameters: Type.Object({
      query: Type.String({ description: "搜索查询" }),
      top_k: Type.Optional(Type.Number({ default: 5 })),
      include_transcripts: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, params: any) {
      const results = await mm.searchMemory(params.query, {
        topK: params.top_k,
        includeTranscripts: params.include_transcripts,
      })
      if (results.length === 0) {
        return ok(`No memory matched query: ${params.query}`)
      }

      return ok(results.map((result, index) =>
        `${index + 1}. [${result.source}] ${result.section}${result.memoryId ? ` (${result.memoryId})` : ""}\n${result.content}`
      ).join("\n\n"))
    },
  }

  const distillMemory: ToolDefinition = {
    name: "distill_memory",
    label: "Distill Memory",
    description: "将每日日志提炼到 MEMORY.md",
    promptSnippet: "distill_memory — 将每日日志提炼到 MEMORY.md",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "指定日期，不传则蒸馏昨天" })),
    }),
    async execute(_id, params: any) {
      try {
        await mm.distillMemory(params.date, distiller)
        brainLogger.info("memory_distill", { date: params.date ?? "yesterday" })
        return ok("Memory distilled to MEMORY.md.")
      } catch (err: any) {
        return ok(`Error: ${err.message}`)
      }
    },
  }

  return [
    { name: "read_memory", description: readMemory.description, group: "memory", tool: readMemory },
    { name: "write_memory", description: writeMemory.description, group: "memory", tool: writeMemory },
    { name: "update_memory", description: updateMemory.description, group: "memory", tool: updateMemory },
    { name: "delete_memory", description: deleteMemory.description, group: "memory", tool: deleteMemory },
    { name: "memory_get", description: memoryGet.description, group: "memory", tool: memoryGet },
    { name: "memory_search", description: memorySearch.description, group: "memory", tool: memorySearch },
    { name: "distill_memory", description: distillMemory.description, group: "memory", tool: distillMemory },
  ]
}

export { createMemoryTools }
