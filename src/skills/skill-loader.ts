import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import { systemLogger } from "../logger/index.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export type TentacleCapabilityType =
  | "api_integration"
  | "llm_reasoning"
  | "database"
  | "content_generation"
  | "external_bot"
  | "action_execution"
  | string

/** Per protocol: three-layer structured capabilities object */
export interface TentacleCapabilities {
  daemon: string[]
  agent: string[]
  consultation: {
    mode: string
    batchThreshold?: number
  }
}

export interface CustomizableField {
  field: string
  description: string
  envVar?: string
  promptPlaceholder?: string
  default?: string
  example?: string
}

export interface SkillTentacleConfig {
  spawnable: true
  runtime: "python" | "typescript" | "go" | "shell"
  entry: string
  defaultTrigger: string
  setupCommands: string[]
  requires: {
    bins: string[]
    env: string[]
  }
  capabilities: TentacleCapabilities
  infrastructure?: {
    needsDatabase?: boolean
    needsLlm?: boolean
    needsHttpServer?: boolean
    needsExternalBot?: boolean
  }
  customizable?: CustomizableField[]
}

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

  // skill_tentacle fields
  isSkillTentacle: boolean
  skillTentacleConfig?: SkillTentacleConfig
}

export class SkillLoader {
  private skills: Map<string, SkillEntry> = new Map()

  constructor(private skillPaths: string[]) {}

  async loadAll(): Promise<SkillEntry[]> {
    this.skills.clear()

    const configuredFound = await this.loadFromPaths(this.skillPaths)
    if (!configuredFound) {
      await this.loadFromPaths([
        path.join(__dirname, "..", "templates", "skills"),
        path.join(__dirname, "..", "..", "src", "templates", "skills"),
      ])
    }

    return Array.from(this.skills.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): SkillEntry | undefined {
    return this.skills.get(name)
  }

  getSpawnable(): SkillEntry[] {
    return Array.from(this.skills.values()).filter((skill) => skill.spawnable)
  }

  async loadSingle(dir: string): Promise<SkillEntry | undefined> {
    const skillMdPath = path.join(dir, "SKILL.md")
    if (!existsSync(skillMdPath)) return undefined
    try {
      const content = await fs.readFile(skillMdPath, "utf-8")
      return parseSkillContent(content, dir)
    } catch {
      return undefined
    }
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

  private async loadFromPaths(paths: string[]): Promise<boolean> {
    let foundAny = false
    for (const basePath of [...paths].reverse()) {
      if (!existsSync(basePath)) continue
      const entries = await fs.readdir(basePath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillPath = path.join(basePath, entry.name, "SKILL.md")
        if (!existsSync(skillPath)) continue
        const content = await fs.readFile(skillPath, "utf-8")
        const skill = parseSkillContent(content, path.join(basePath, entry.name))
        this.skills.set(skill.name, skill)
        foundAny = true
        if (skill.isSkillTentacle) {
          systemLogger.info("skill_tentacle_discovered", { name: skill.name, path: skill.path })
        }
      }
    }
    return foundAny
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

  // Detect metadata.openceph.tentacle for skill_tentacle
  const metadata = frontmatter.metadata as Record<string, unknown> | undefined
  const opencephMeta = metadata?.openceph as Record<string, unknown> | undefined
  const tentacleMeta = opencephMeta?.tentacle as Record<string, unknown> | undefined
  const metaSpawnable = tentacleMeta ? asBoolean(tentacleMeta.spawnable) : false

  // Extract openceph-level emoji and trigger_keywords
  const metaEmoji = opencephMeta ? asString(opencephMeta.emoji) : undefined
  const metaTriggerKeywords = opencephMeta ? asStringArray(opencephMeta.trigger_keywords) : []

  // skill_tentacle detection: metadata.openceph.tentacle.spawnable + prompt/SYSTEM.md + src/ + README.md
  const isSkillTentacle = metaSpawnable
    && existsSync(path.join(skillDir, "prompt", "SYSTEM.md"))
    && existsSync(path.join(skillDir, "src"))
    && existsSync(path.join(skillDir, "README.md"))

  // Parse skill_tentacle config from metadata.openceph.tentacle
  let skillTentacleConfig: SkillTentacleConfig | undefined
  if (isSkillTentacle && tentacleMeta) {
    const tRuntime = asString(tentacleMeta.runtime) ?? runtime ?? "python"
    const tEntry = asString(tentacleMeta.entry) ?? entry ?? "src/main.py"
    const tDefaultTrigger = asString(tentacleMeta.default_trigger) ?? defaultTrigger ?? "every 30 minutes"
    const tSetupCommands = asStringArray(tentacleMeta.setup_commands).length > 0
      ? asStringArray(tentacleMeta.setup_commands)
      : setupCommands
    const tRequires = tentacleMeta.requires
      ? toStringRecord(tentacleMeta.requires)
      : requires
    const tCapabilities = parseCapabilities(tentacleMeta.capabilities)
    const tInfra = tentacleMeta.infrastructure as Record<string, unknown> | undefined
    const tCustomizable = parseCustomizableFields(tentacleMeta.customizable)

    skillTentacleConfig = {
      spawnable: true,
      runtime: tRuntime as SkillTentacleConfig["runtime"],
      entry: tEntry,
      defaultTrigger: tDefaultTrigger,
      setupCommands: tSetupCommands,
      requires: tRequires,
      capabilities: tCapabilities,
      infrastructure: tInfra ? {
        needsDatabase: asBoolean(tInfra.needsDatabase),
        needsLlm: asBoolean(tInfra.needsLlm),
        needsHttpServer: asBoolean(tInfra.needsHttpServer),
        needsExternalBot: asBoolean(tInfra.needsExternalBot),
      } : undefined,
      customizable: tCustomizable.length > 0 ? tCustomizable : undefined,
    }
  }

  const effectiveSpawnable = spawnable || metaSpawnable

  return {
    name,
    description,
    version,
    path: skillDir,
    spawnable: effectiveSpawnable,
    tentacleConfig: runtime || entry || defaultTrigger || setupCommands.length > 0 || requires.bins.length > 0 || requires.env.length > 0
      ? {
          runtime,
          entry,
          defaultTrigger,
          setupCommands,
          requires,
        }
      : skillTentacleConfig ? {
          runtime: skillTentacleConfig.runtime,
          entry: skillTentacleConfig.entry,
          defaultTrigger: skillTentacleConfig.defaultTrigger,
          setupCommands: skillTentacleConfig.setupCommands,
          requires: skillTentacleConfig.requires,
        }
      : undefined,
    triggerKeywords: metaTriggerKeywords.length > 0
      ? metaTriggerKeywords
      : asStringArray(frontmatter.trigger_keywords),
    emoji: metaEmoji ?? asString(frontmatter.emoji),
    isSkillTentacle,
    skillTentacleConfig,
  }
}

function parseCustomizableFields(value: unknown): CustomizableField[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      field: asString(item.field) ?? "",
      description: asString(item.description) ?? "",
      envVar: asString(item.env_var),
      promptPlaceholder: asString(item.prompt_placeholder),
      default: asString(item.default),
      example: asString(item.example),
    }))
    .filter((f) => f.field)
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

  // Simple list: all items are "- scalar"
  if (trimmed.every((line) => line.trim().startsWith("- "))) {
    return trimmed.map((line) => parseScalar(line.trim().slice(2).trim()))
  }

  // List of objects: first line starts with "- key:" and subsequent lines are indented
  const firstStripped = trimmed[0].trim()
  if (firstStripped.startsWith("- ")) {
    return parseListOfObjects(trimmed)
  }

  // Determine the base indentation level (minimum indent of first key line)
  const baseIndent = trimmed.reduce((min, line) => {
    const m = line.match(/^(\s*)/)
    const indent = m ? m[1].length : 0
    return indent < min ? indent : min
  }, Infinity)

  const result: Record<string, unknown> = {}
  let i = 0
  while (i < trimmed.length) {
    const line = trimmed[i]
    const lineIndent = (line.match(/^(\s*)/) || ["", ""])[1].length
    const stripped = line.trim()
    const match = stripped.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/)
    if (!match || lineIndent > baseIndent) {
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

    // Collect nested content — lines with deeper indentation
    const nestedLines: string[] = []
    i++
    while (i < trimmed.length) {
      const nextLineIndent = (trimmed[i].match(/^(\s*)/) || ["", ""])[1].length
      if (nextLineIndent <= baseIndent) break
      nestedLines.push(trimmed[i])
      i++
    }
    if (nestedLines.length > 0) {
      result[key] = parseIndentedBlock(nestedLines)
    } else {
      result[key] = ""
    }
  }
  return result
}

function parseListOfObjects(lines: string[]): unknown[] {
  const items: string[][] = []
  let current: string[] = []

  for (const line of lines) {
    const stripped = line.trim()
    if (stripped.startsWith("- ")) {
      if (current.length > 0) items.push(current)
      // Convert "- key: value" to "key: value" for the first line of the item
      current = [stripped.slice(2)]
    } else {
      current.push(stripped)
    }
  }
  if (current.length > 0) items.push(current)

  return items.map((itemLines) => {
    // If single line, treat as scalar
    if (itemLines.length === 1 && !itemLines[0].includes(":")) {
      return parseScalar(itemLines[0])
    }
    // Parse as key-value object
    const obj: Record<string, unknown> = {}
    for (const itemLine of itemLines) {
      const m = itemLine.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/)
      if (m) {
        obj[m[1]] = parseScalar((m[2] ?? "").trim())
      }
    }
    return obj
  })
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

/** Parse capabilities as structured three-layer object per protocol spec. */
function parseCapabilities(value: unknown): TentacleCapabilities {
  const defaultCaps: TentacleCapabilities = {
    daemon: [],
    agent: [],
    consultation: { mode: "batch" },
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultCaps
  }
  const obj = value as Record<string, unknown>
  const consultation = obj.consultation
  let consultationParsed: TentacleCapabilities["consultation"] = { mode: "batch" }
  if (consultation && typeof consultation === "object" && !Array.isArray(consultation)) {
    const c = consultation as Record<string, unknown>
    const rawThreshold = c.batchThreshold ?? c.batch_threshold
    const threshold = rawThreshold != null ? Number(rawThreshold) : undefined
    consultationParsed = {
      mode: typeof c.mode === "string" ? c.mode : "batch",
      ...(threshold != null && !isNaN(threshold) ? { batchThreshold: threshold } : {}),
    }
  }
  return {
    daemon: asStringArray(obj.daemon),
    agent: asStringArray(obj.agent),
    consultation: consultationParsed,
  }
}

function toStringRecord(value: unknown): { bins: string[]; env: string[] } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {}
  return {
    bins: asStringArray(record.bins),
    env: asStringArray(record.env),
  }
}
