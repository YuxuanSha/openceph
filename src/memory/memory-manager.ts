import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"
import {
  parseSections,
  updateSection,
  generateMemoryId,
  appendToSection,
  replaceMemoryById,
  deleteMemoryById,
  parseMemoryEntries,
  normalizeMemoryId,
} from "./memory-parser.js"
import { MemorySearchEngine, type MemorySearchResult } from "./memory-search.js"
import type { MemoryDistiller } from "./memory-distiller.js"

export class MemoryManager {
  private memoryDir: string
  private memoryMdPath: string
  private searchEngine: MemorySearchEngine

  constructor(private workspaceDir: string) {
    this.memoryDir = path.join(workspaceDir, "memory")
    this.memoryMdPath = path.join(workspaceDir, "MEMORY.md")
    this.searchEngine = new MemorySearchEngine(workspaceDir)
  }

  /** Read MEMORY.md full content or a specific section */
  async readMemory(section?: string, query?: string): Promise<string> {
    try {
      const content = await fs.readFile(this.memoryMdPath, "utf-8")
      if (query) {
        const lines = content
          .split("\n")
          .filter((line) => line.toLowerCase().includes(query.toLowerCase()))
        return lines.length > 0 ? lines.join("\n") : `No lines matched query: ${query}`
      }
      if (!section) return content
      const sections = parseSections(content)
      return sections.get(section) ?? `Section "${section}" not found in MEMORY.md`
    } catch {
      return "MEMORY.md not found"
    }
  }

  /** Write a memory entry to daily log memory/YYYY-MM-DD.md */
  async writeMemory(content: string, section: string, tags?: string[]): Promise<string> {
    const date = new Date().toISOString().slice(0, 10)
    const filePath = path.join(this.memoryDir, `${date}.md`)

    await fs.mkdir(this.memoryDir, { recursive: true })

    let existing = ""
    try {
      existing = await fs.readFile(filePath, "utf-8")
    } catch {
      existing = `# Memory Log ${date}\n`
    }

    const memoryId = generateMemoryId(date, existing)
    const tagLine = tags?.length ? `\ntags: ${tags.join(", ")}` : ""
    const entry = `<!-- ${memoryId} -->\n- ${content}${tagLine}`
    const updated = appendToSection(existing, section, entry)
    await fs.writeFile(filePath, updated, "utf-8")
    await this.searchEngine.reindex()
    return memoryId
  }

  /** Update an existing memory entry by ID */
  async updateMemory(memoryId: string, content: string): Promise<void> {
    const normalized = normalizeMemoryId(memoryId)
    const date = normalized.slice(4, 14)
    const filePath = path.join(this.memoryDir, `${date}.md`)

    if (!existsSync(filePath)) {
      throw new Error(`Memory file not found for date: ${date}`)
    }

    const existing = await fs.readFile(filePath, "utf-8")
    const updated = replaceMemoryById(existing, normalized, `- ${content}`)
    await fs.writeFile(filePath, updated, "utf-8")

    if (existsSync(this.memoryMdPath)) {
      const memoryMd = await fs.readFile(this.memoryMdPath, "utf-8")
      const updatedMemoryMd = replaceMemoryById(memoryMd, normalized, `- [${date}] ${content}`)
      await fs.writeFile(this.memoryMdPath, updatedMemoryMd, "utf-8")
    }
    await this.searchEngine.reindex()
  }

  /** Delete a memory entry by ID */
  async deleteMemory(memoryId: string): Promise<void> {
    const normalized = normalizeMemoryId(memoryId)
    const date = normalized.slice(4, 14)
    const filePath = path.join(this.memoryDir, `${date}.md`)

    if (!existsSync(filePath)) {
      throw new Error(`Memory file not found for date: ${date}`)
    }

    const existing = await fs.readFile(filePath, "utf-8")
    const updated = deleteMemoryById(existing, normalized)
    await fs.writeFile(filePath, updated, "utf-8")

    if (existsSync(this.memoryMdPath)) {
      const memoryMd = await fs.readFile(this.memoryMdPath, "utf-8")
      const updatedMemoryMd = deleteMemoryById(memoryMd, normalized)
      await fs.writeFile(this.memoryMdPath, updatedMemoryMd, "utf-8")
    }
    await this.searchEngine.reindex()
  }

  /** Read a specific memory file */
  async getMemoryFile(
    relativePath: string,
    lineRange?: { start: number; end: number },
  ): Promise<string> {
    const sanitized = relativePath.startsWith("memory/")
      ? relativePath.slice("memory/".length)
      : relativePath
    const filePath = path.join(this.memoryDir, sanitized)
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(path.resolve(this.memoryDir))) {
      throw new Error("Path must stay within workspace memory/")
    }
    const content = await fs.readFile(filePath, "utf-8")
    if (!lineRange) return content
    const lines = content.split("\n")
    return lines.slice(lineRange.start - 1, lineRange.end).join("\n")
  }

  async searchMemory(
    query: string,
    options?: { topK?: number; includeTranscripts?: boolean },
  ): Promise<MemorySearchResult[]> {
    await this.searchEngine.initialize()
    return this.searchEngine.search(query, options)
  }

  /** Distill daily log into MEMORY.md (M1: simple append, M2: LLM-assisted) */
  async distillMemory(date?: string, distiller?: MemoryDistiller): Promise<void> {
    const targetDate = date ?? (() => {
      const d = new Date()
      d.setDate(d.getDate() - 1)
      return d.toISOString().slice(0, 10)
    })()

    const filePath = path.join(this.memoryDir, `${targetDate}.md`)
    if (!existsSync(filePath)) return

    const dailyContent = await fs.readFile(filePath, "utf-8")
    const dailyEntries = parseMemoryEntries(dailyContent)

    let memoryContent = ""
    try {
      memoryContent = await fs.readFile(this.memoryMdPath, "utf-8")
    } catch {
      memoryContent = "# MEMORY.md — 用户长期记忆\n"
    }

    const distilled = distiller
      ? await distiller.distill({
          targetDate,
          dailyContent,
          memoryContent,
          entries: dailyEntries,
        })
      : dailyEntries.map((entry) => ({
          section: entry.section,
          memoryId: entry.memoryId,
          content: entry.body.startsWith("- ") ? entry.body : `- ${entry.body}`,
        }))

    if (distilled.length === 0 && dailyEntries.length === 0) {
      const dailySections = parseSections(dailyContent)
      for (const [section, content] of dailySections) {
        if (!content.trim()) continue
        const prefixed = content.split("\n")
          .map((line) => line.trim() ? `[${targetDate}] ${line}` : line)
          .join("\n")
        memoryContent = updateSection(memoryContent, section, prefixed)
      }
    } else {
      for (const item of distilled) {
        const memoryId = item.memoryId ?? generateMemoryId(targetDate, memoryContent)
        const body = item.content
          .split("\n")
          .map((line, index) => {
            if (!line.trim()) return line
            if (index === 0 && line.trim().startsWith("- ")) {
              return `- [${targetDate}] ${line.trim().slice(2)}`
            }
            return line
          })
          .join("\n")
        const existing = replaceMemoryById(memoryContent, memoryId, body)
        if (existing !== memoryContent) {
          memoryContent = existing
        } else {
          memoryContent = appendToSection(memoryContent, item.section, `<!-- ${memoryId} -->\n${body}`)
        }
      }
    }

    await fs.writeFile(this.memoryMdPath, memoryContent, "utf-8")
    await this.searchEngine.reindex()
  }
}
