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
    description: "Read a specified section or the full content of MEMORY.md",
    promptSnippet: "read_memory — read MEMORY.md or search memory contents",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search keyword; if omitted, returns the full content" })),
      section: Type.Optional(Type.String({ description: "Specific section name to read" })),
    }),
    async execute(_id, params: any) {
      const content = await mm.readMemory(params.section, params.query)
      return ok(content)
    },
  }

  const writeMemory: ToolDefinition = {
    name: "write_memory",
    label: "Write Memory",
    description: "Write a memory entry to the daily log memory/YYYY-MM-DD.md",
    promptSnippet: "write_memory — write a new memory entry to the daily log",
    parameters: Type.Object({
      content: Type.String({ description: "The memory content to write" }),
      section: Type.String({ description: "Target section" }),
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
    description: "Update an existing memory entry",
    promptSnippet: "update_memory — update an existing memory entry",
    parameters: Type.Object({
      memory_id: Type.String({ description: "Memory ID, format: YYYY-MM-DD-NNN" }),
      content: Type.String({ description: "New content" }),
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
    description: "Delete a specified memory entry",
    promptSnippet: "delete_memory — delete a specified memory entry",
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
    description: "Read a specified memory file",
    promptSnippet: "memory_get — read the contents of a specified memory file",
    parameters: Type.Object({
      path: Type.String({ description: "Memory file path, e.g. 2026-03-19.md" }),
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
    description: "Search for relevant memories in MEMORY.md and memory/ daily logs",
    promptSnippet: "memory_search — search long-term memory and daily memory logs",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
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
    description: "Distill daily logs into MEMORY.md",
    promptSnippet: "distill_memory — distill daily logs into MEMORY.md",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "Specify a date; if omitted, distills yesterday's log" })),
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
