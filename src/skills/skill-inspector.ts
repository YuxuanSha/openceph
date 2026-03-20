import { execFile } from "child_process"
import { detectRuntimes } from "../tentacle/runtime-detector.js"
import type { SkillEntry } from "./skill-loader.js"

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export class SkillInspector {
  static parse(skillMdContent: string): SkillEntry {
    const normalized = skillMdContent.replace(/\r\n/g, "\n")
    const fields = parseFrontmatter(normalized)

    return {
      name: asString(fields.name) ?? "unknown-skill",
      description: asString(fields.description) ?? "",
      version: asString(fields.version) ?? "0.1.0",
      path: "",
      spawnable: fields.spawnable === true || fields.spawnable === "true",
      tentacleConfig: {
        runtime: asString(fields.runtime),
        entry: asString(fields.entry),
        defaultTrigger: asString(fields.default_trigger),
        setupCommands: asStringArray(fields.setup_commands),
        requires: parseRequires(fields.requires),
      },
      triggerKeywords: asStringArray(fields.trigger_keywords),
      emoji: asString(fields.emoji),
    }
  }

  static async validate(skill: SkillEntry): Promise<ValidationResult> {
    const errors: string[] = []
    const warnings: string[] = []
    if (!skill.name) errors.push("missing skill name")
    if (skill.spawnable && !skill.tentacleConfig?.runtime) {
      errors.push("spawnable skill missing runtime")
    }
    if (skill.spawnable && !skill.tentacleConfig?.entry) {
      errors.push("spawnable skill missing entry")
    }

    if (skill.tentacleConfig?.runtime) {
      const runtimes = await detectRuntimes()
      if (skill.tentacleConfig.runtime === "python" && !runtimes.python3) {
        errors.push("python3 not found")
      }
      if (skill.tentacleConfig.runtime === "typescript" && !runtimes.node) {
        errors.push("node not found")
      }
    }

    for (const bin of skill.tentacleConfig?.requires.bins ?? []) {
      if (!(await hasCommand(bin))) {
        errors.push(`${bin} not found`)
      }
    }

    for (const envName of skill.tentacleConfig?.requires.env ?? []) {
      if (!process.env[envName]) {
        errors.push(`${envName} not set`)
      }
    }

    if (skill.spawnable && !skill.tentacleConfig?.defaultTrigger) {
      warnings.push("spawnable skill missing default_trigger")
    }

    return { valid: errors.length === 0, errors, warnings }
  }
}

function hasCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("bash", ["-lc", `command -v ${JSON.stringify(command)}`], (error) => resolve(!error))
  })
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return {}

  const result: Record<string, unknown> = {}
  const lines = match[1].split("\n")
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const top = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/)
    if (!top) {
      i++
      continue
    }

    const key = top[1]
    const inlineValue = (top[2] ?? "").trim()
    if (inlineValue) {
      result[key] = parseScalar(inlineValue)
      i++
      continue
    }

    const childLines: string[] = []
    i++
    while (i < lines.length && (/^\s+/.test(lines[i]) || !lines[i].trim())) {
      childLines.push(lines[i])
      i++
    }
    result[key] = parseIndented(childLines)
  }

  return result
}

function parseIndented(lines: string[]): unknown {
  const trimmed = lines.filter((line) => line.trim())
  if (trimmed.every((line) => line.trim().startsWith("- "))) {
    return trimmed.map((line) => parseScalar(line.trim().slice(2).trim()))
  }

  const result: Record<string, unknown> = {}
  let i = 0
  while (i < trimmed.length) {
    const line = trimmed[i].replace(/^\s+/, "")
    const match = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/)
    if (!match) {
      i++
      continue
    }
    const key = match[1]
    const inlineValue = (match[2] ?? "").trim()
    if (inlineValue) {
      result[key] = parseScalar(inlineValue)
      i++
      continue
    }
    const items: string[] = []
    i++
    while (i < trimmed.length && trimmed[i].trim().startsWith("- ")) {
      items.push(trimmed[i])
      i++
    }
    result[key] = items.map((item) => parseScalar(item.trim().slice(2).trim()))
  }
  return result
}

function parseScalar(value: string): unknown {
  const cleaned = value.trim().replace(/^['"]|['"]$/g, "")
  if (cleaned === "true") return true
  if (cleaned === "false") return false
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    return cleaned.slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean)
  }
  return cleaned
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean)
  }
  return []
}

function parseRequires(value: unknown): { bins: string[]; env: string[] } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {}
  return {
    bins: asStringArray(record.bins),
    env: asStringArray(record.env),
  }
}
