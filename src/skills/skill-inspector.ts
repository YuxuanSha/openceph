import { execFile } from "child_process"
import { existsSync } from "fs"
import * as fs from "fs/promises"
import * as path from "path"
import { detectRuntimes } from "../tentacle/runtime-detector.js"
import type { SkillEntry } from "./skill-loader.js"
import type { ValidationError } from "../code-agent/code-agent.js"

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface SkillTentacleValidationResult {
  valid: boolean
  errors: ValidationError[]
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
      isSkillTentacle: false,
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

  /**
   * Check if a skill directory is a valid skill_tentacle.
   * Conditions: metadata.openceph.tentacle.spawnable + prompt/SYSTEM.md + src/ + README.md
   */
  static isSkillTentacle(skillPath: string): boolean {
    if (!existsSync(path.join(skillPath, "SKILL.md"))) return false
    if (!existsSync(path.join(skillPath, "prompt", "SYSTEM.md"))) return false
    if (!existsSync(path.join(skillPath, "src"))) return false
    if (!existsSync(path.join(skillPath, "README.md"))) return false

    // Check SKILL.md frontmatter for metadata.openceph.tentacle.spawnable
    try {
      const content = require("fs").readFileSync(path.join(skillPath, "SKILL.md"), "utf-8")
      const fields = parseFrontmatter(content.replace(/\r\n/g, "\n"))
      const metadata = fields.metadata as Record<string, unknown> | undefined
      const openceph = metadata?.openceph as Record<string, unknown> | undefined
      const tentacle = openceph?.tentacle as Record<string, unknown> | undefined
      return tentacle?.spawnable === true || tentacle?.spawnable === "true"
    } catch {
      return false
    }
  }

  /**
   * Validate a skill_tentacle directory for structural completeness.
   */
  static async validateSkillTentacle(skillPath: string): Promise<SkillTentacleValidationResult> {
    const errors: ValidationError[] = []
    const warnings: string[] = []

    // Required files
    const required = ["SKILL.md", "README.md", "prompt/SYSTEM.md"]
    for (const f of required) {
      if (!existsSync(path.join(skillPath, f))) {
        errors.push({ check: "structure" as any, message: `Required file missing: ${f}` })
      }
    }

    // src/ directory must exist and have a main entry
    if (!existsSync(path.join(skillPath, "src"))) {
      errors.push({ check: "structure" as any, message: "src/ directory missing" })
    } else {
      // Check for entry file
      const hasMain = existsSync(path.join(skillPath, "src", "main.py"))
        || existsSync(path.join(skillPath, "src", "index.ts"))
        || existsSync(path.join(skillPath, "src", "main.ts"))
        || existsSync(path.join(skillPath, "src", "main.go"))
        || existsSync(path.join(skillPath, "src", "main.sh"))
      if (!hasMain) {
        warnings.push("No standard main entry file found in src/ (main.py / index.ts / main.go / main.sh)")
      }

      // Check for dependency file
      const hasDeps = existsSync(path.join(skillPath, "src", "requirements.txt"))
        || existsSync(path.join(skillPath, "src", "package.json"))
        || existsSync(path.join(skillPath, "package.json"))
        || existsSync(path.join(skillPath, "src", "go.mod"))
      if (!hasDeps) {
        warnings.push("No dependency declaration file found (requirements.txt / package.json / go.mod)")
      }
    }

    // SKILL.md frontmatter check
    const skillMdPath = path.join(skillPath, "SKILL.md")
    if (existsSync(skillMdPath)) {
      try {
        const skillMd = await fs.readFile(skillMdPath, "utf-8")
        const fields = parseFrontmatter(skillMd.replace(/\r\n/g, "\n"))
        const metadata = fields.metadata as Record<string, unknown> | undefined
        const openceph = metadata?.openceph as Record<string, unknown> | undefined
        const tentacle = openceph?.tentacle as Record<string, unknown> | undefined
        if (!tentacle || (tentacle.spawnable !== true && tentacle.spawnable !== "true")) {
          errors.push({
            check: "structure" as any,
            message: "SKILL.md frontmatter missing metadata.openceph.tentacle.spawnable: true",
          })
        }
      } catch {
        errors.push({ check: "structure" as any, message: "Failed to parse SKILL.md" })
      }
    }

    // README.md content check
    const readmePath = path.join(skillPath, "README.md")
    if (existsSync(readmePath)) {
      try {
        const readme = await fs.readFile(readmePath, "utf-8")
        if (!readme.includes("Environment") && !readme.includes("env") && !readme.includes("Variables")) {
          warnings.push("README.md missing environment variables section")
        }
        if (!readme.includes("Deploy") && !readme.includes("Setup") && !readme.includes("Install") && !readme.includes("## ")) {
          warnings.push("README.md missing deployment steps section")
        }
        if (!readme.includes("Start") && !readme.includes("Command") && !readme.includes("Run")) {
          warnings.push("README.md missing start command section")
        }
      } catch {
        // ignore read errors
      }
    }

    // prompt/SYSTEM.md non-empty check
    const systemMdPath = path.join(skillPath, "prompt", "SYSTEM.md")
    let systemMdContent = ""
    if (existsSync(systemMdPath)) {
      try {
        systemMdContent = await fs.readFile(systemMdPath, "utf-8")
        if (systemMdContent.trim().length < 50) {
          errors.push({ check: "structure" as any, message: "prompt/SYSTEM.md content too short (< 50 characters)" })
        }
      } catch {
        errors.push({ check: "structure" as any, message: "Failed to read prompt/SYSTEM.md" })
      }
    }

    // Customizable field cross-referencing check
    if (existsSync(skillMdPath)) {
      try {
        const skillMd = await fs.readFile(skillMdPath, "utf-8")
        const fields = parseFrontmatter(skillMd.replace(/\r\n/g, "\n"))
        const metadata = fields.metadata as Record<string, unknown> | undefined
        const openceph = metadata?.openceph as Record<string, unknown> | undefined
        const tentacle = openceph?.tentacle as Record<string, unknown> | undefined
        const customizable = tentacle?.customizable
        if (Array.isArray(customizable)) {
          // Read all src/ code for env_var checking
          let srcContent = ""
          const srcDir = path.join(skillPath, "src")
          if (existsSync(srcDir)) {
            srcContent = await readDirContents(srcDir)
          }

          for (const item of customizable) {
            if (typeof item !== "object" || item === null) continue
            const field = item as Record<string, unknown>
            const envVar = typeof field.env_var === "string" ? field.env_var : undefined
            const promptPlaceholder = typeof field.prompt_placeholder === "string" ? field.prompt_placeholder : undefined
            const fieldName = typeof field.field === "string" ? field.field : "unknown"

            if (envVar && !srcContent.includes(envVar)) {
              warnings.push(`customizable field "${fieldName}" env_var "${envVar}" not referenced in src/ files`)
            }
            if (promptPlaceholder && systemMdContent && !systemMdContent.includes(promptPlaceholder)) {
              warnings.push(`customizable field "${fieldName}" prompt_placeholder "${promptPlaceholder}" not found in prompt/SYSTEM.md`)
            }
          }
        }
      } catch {
        // ignore parse errors — already reported above
      }
    }

    return { valid: errors.length === 0, errors, warnings }
  }
}

async function readDirContents(dir: string): Promise<string> {
  const parts: string[] = []
  const walk = async (d: string) => {
    const entries = await fs.readdir(d, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!["venv", "node_modules", "__pycache__"].includes(entry.name)) {
          await walk(path.join(d, entry.name))
        }
      } else if (/\.(py|ts|js|go|sh)$/.test(entry.name)) {
        try {
          parts.push(await fs.readFile(path.join(d, entry.name), "utf-8"))
        } catch {}
      }
    }
  }
  await walk(dir)
  return parts.join("\n")
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
    const match = line.match(/^(\s*)/)
    const indent = match ? match[1].length : 0
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
      result[key] = parseIndented(nestedLines)
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
      current = [stripped.slice(2)]
    } else {
      current.push(stripped)
    }
  }
  if (current.length > 0) items.push(current)

  return items.map((itemLines) => {
    if (itemLines.length === 1 && !itemLines[0].includes(":")) {
      return parseScalar(itemLines[0])
    }
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
