import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface SkillEntry {
  name: string
  description: string
  version: string
  path: string
  spawnable: boolean
  tentacleConfig?: {
    runtime?: string
    entry?: string
    defaultTrigger?: string
    setupCommands: string[]
    requires: { bins: string[]; env: string[] }
  }
  triggerKeywords?: string[]
  emoji?: string
}

export class SkillLoader {
  private skills: Map<string, SkillEntry> = new Map()

  constructor(private skillPaths: string[]) {}

  async loadAll(): Promise<SkillEntry[]> {
    this.skills.clear()

    const configuredPaths = [...this.skillPaths].reverse()
    const bundledPaths = [
      path.join(__dirname, "..", "templates", "skills"),
      path.join(__dirname, "..", "..", "src", "templates", "skills"),
    ]
    const allPaths = [
      ...bundledPaths,
      ...configuredPaths,
    ]

    for (const basePath of allPaths) {
      if (!existsSync(basePath)) continue
      const entries = await fs.readdir(basePath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillPath = path.join(basePath, entry.name, "SKILL.md")
        if (!existsSync(skillPath)) continue
        const content = await fs.readFile(skillPath, "utf-8")
        const skill = parseSkillContent(content, path.join(basePath, entry.name))
        this.skills.set(skill.name, skill)
      }
    }

    return Array.from(this.skills.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): SkillEntry | undefined {
    return this.skills.get(name)
  }

  getSpawnable(): SkillEntry[] {
    return Array.from(this.skills.values()).filter((skill) => skill.spawnable)
  }

  async readSkillContent(name: string): Promise<{ content: string; references: string[] }> {
    const skill = this.skills.get(name)
    if (!skill) {
      throw new Error(`Skill not found: ${name}`)
    }

    const skillMdPath = path.join(skill.path, "SKILL.md")
    const content = await fs.readFile(skillMdPath, "utf-8")
    const referencesDir = path.join(skill.path, "references")
    const references = existsSync(referencesDir)
      ? (await fs.readdir(referencesDir)).sort()
      : []
    return { content, references }
  }
}

function parseSkillContent(content: string, skillDir: string): SkillEntry {
  const normalized = content.replace(/\r\n/g, "\n")
  const frontmatter = parseFrontmatter(normalized)
  const name = asString(frontmatter.name) ?? path.basename(skillDir)
  const description = asString(frontmatter.description)
    ?? normalized.split("\n").find((line) => line.trim() && !line.startsWith("---") && !line.startsWith("#"))?.trim()
    ?? ""
  const version = asString(frontmatter.version) ?? "0.1.0"
  const spawnable = asBoolean(frontmatter.spawnable)
  const runtime = asString(frontmatter.runtime)
  const entry = asString(frontmatter.entry)
  const defaultTrigger = asString(frontmatter.default_trigger)
  const setupCommands = asStringArray(frontmatter.setup_commands)
  const requires = toStringRecord(frontmatter.requires)

  return {
    name,
    description,
    version,
    path: skillDir,
    spawnable,
    tentacleConfig: runtime || entry || defaultTrigger || setupCommands.length > 0 || requires.bins.length > 0 || requires.env.length > 0
      ? {
          runtime,
          entry,
          defaultTrigger,
          setupCommands,
          requires,
        }
      : undefined,
    triggerKeywords: asStringArray(frontmatter.trigger_keywords),
    emoji: asString(frontmatter.emoji),
  }
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return {}

  const lines = match[1].split("\n")
  const root: Record<string, unknown> = {}
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    const topLevel = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/)
    if (!topLevel) {
      i++
      continue
    }

    const key = topLevel[1]
    const inlineValue = (topLevel[2] ?? "").trim()
    if (inlineValue) {
      root[key] = parseScalar(inlineValue)
      i++
      continue
    }

    const childLines: string[] = []
    i++
    while (i < lines.length && (/^\s+/.test(lines[i]) || !lines[i].trim())) {
      childLines.push(lines[i])
      i++
    }
    root[key] = parseIndentedBlock(childLines)
  }

  return root
}

function parseIndentedBlock(lines: string[]): unknown {
  const trimmed = lines.filter((line) => line.trim())
  if (trimmed.length === 0) return ""

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

    const arrayLines: string[] = []
    i++
    while (i < trimmed.length && trimmed[i].trim().startsWith("- ")) {
      arrayLines.push(trimmed[i])
      i++
    }
    result[key] = arrayLines.map((item) => parseScalar(item.trim().slice(2).trim()))
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
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.replace(/^['"]|['"]$/g, ""))
  }
  return cleaned
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true"
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

function toStringRecord(value: unknown): { bins: string[]; env: string[] } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {}
  return {
    bins: asStringArray(record.bins),
    env: asStringArray(record.env),
  }
}
