import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { OpenCephConfig } from "../config/config-schema.js"
import type { PiContext } from "../pi/pi-context.js"
import { createBrainSession } from "../pi/pi-session.js"
import type { ParsedMemoryEntry } from "./memory-parser.js"

export interface DistilledMemoryUpdate {
  section: string
  memoryId?: string
  content: string
}

export class MemoryDistiller {
  constructor(
    private piCtx: PiContext,
    private config: OpenCephConfig,
  ) {}

  async distill(input: {
    targetDate: string
    dailyContent: string
    memoryContent: string
    entries: ParsedMemoryEntry[]
  }): Promise<DistilledMemoryUpdate[]> {
    const tempSessionPath = path.join(
      os.tmpdir(),
      `openceph-memory-distill-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    )

    const prompt = [
      "You are a memory distillation assistant for OpenCeph.",
      "Return JSON only. No markdown, no explanation.",
      "Goal: merge the daily memory log into long-term memory.",
      "Rules:",
      "- Keep only durable preferences, constraints, recurring tasks, decisions, identities, and important ongoing projects.",
      "- Ignore transient chatter.",
      "- Preserve an existing memory_id when updating an existing long-term memory entry.",
      "- Every item must contain section and content. memoryId is optional.",
      "- content must be concise markdown bullet content without the HTML marker line.",
      "",
      "Expected JSON schema:",
      '[{"section":"string","memoryId":"optional mem:YYYY-MM-DD-NNN","content":"- concise memory"}]',
      "",
      `Target date: ${input.targetDate}`,
      "",
      "Daily log:",
      input.dailyContent,
      "",
      "Current MEMORY.md:",
      input.memoryContent,
    ].join("\n")

    try {
      const session = await createBrainSession(this.piCtx, this.config, {
        sessionFilePath: tempSessionPath,
        modelId: this.config.agents.defaults.model.primary,
        customTools: [],
      })
      const raw = await session.prompt(prompt)
      const parsed = parseDistillJson(raw)
      if (parsed.length > 0) return parsed
    } catch {
      // Fall back to deterministic distillation below.
    } finally {
      await fs.rm(tempSessionPath, { force: true }).catch(() => undefined)
    }

    return input.entries.map((entry) => ({
      section: entry.section,
      memoryId: entry.memoryId,
      content: entry.body.startsWith("- ") ? entry.body : `- ${entry.body}`,
    }))
  }
}

function parseDistillJson(raw: string): DistilledMemoryUpdate[] {
  const trimmed = raw.trim()
  const candidates = [
    trimmed,
    extractJsonBlock(trimmed),
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (!Array.isArray(parsed)) continue
      return parsed
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({
          section: typeof item.section === "string" ? item.section : "General",
          memoryId: typeof item.memoryId === "string" ? item.memoryId : undefined,
          content: normalizeBullet(typeof item.content === "string" ? item.content : ""),
        }))
        .filter((item) => item.content.length > 0)
    } catch {
      // Try the next candidate.
    }
  }

  return []
}

function extractJsonBlock(raw: string): string {
  const codeFence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (codeFence) return codeFence[1].trim()

  const arrayMatch = raw.match(/\[[\s\S]*\]/)
  return arrayMatch ? arrayMatch[0].trim() : raw
}

function normalizeBullet(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) return ""
  return trimmed.startsWith("- ") ? trimmed : `- ${trimmed.replace(/^-+\s*/, "")}`
}
