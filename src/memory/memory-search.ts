import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as os from "os"
import * as path from "path"
import { DatabaseSync } from "node:sqlite"
import { parseMemoryEntries, parseSections } from "./memory-parser.js"

export interface MemorySearchResult {
  source: string
  section: string
  memoryId: string | null
  content: string
  score: number
}

interface IndexedChunk {
  source: string
  section: string
  memoryId: string | null
  chunkText: string
}

export class MemorySearchEngine {
  private db: DatabaseSync | null = null

  constructor(
    private workspaceDir: string,
    private dbPath: string = path.join(workspaceDir, "memory-index", "memory.db"),
  ) {}

  async initialize(): Promise<void> {
    if (this.db) return
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        section TEXT,
        memory_id TEXT,
        indexed_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        chunk_text,
        content='memory_chunks',
        content_rowid='id',
        tokenize='unicode61'
      );
    `)
  }

  async indexMemoryFile(filePath: string, content: string): Promise<void> {
    await this.initialize()
    this.deleteSource(filePath)
    this.insertChunks(filePath, parseChunksForSource(filePath, content))
  }

  async indexTranscript(sessionId: string, content: string): Promise<void> {
    await this.initialize()
    const source = `transcript:${sessionId}`
    this.deleteSource(source)

    const chunks = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => {
        const role = typeof item.role === "string" ? item.role : "message"
        const text = typeof item.content === "string"
          ? item.content
          : JSON.stringify(item.content ?? item)
        return {
          source,
          section: role,
          memoryId: null,
          chunkText: text.slice(0, 4000),
        } satisfies IndexedChunk
      })
      .filter((chunk) => chunk.chunkText.trim().length > 0)

    this.insertChunks(source, chunks)
  }

  async reindex(): Promise<void> {
    await this.initialize()
    this.db!.exec("DELETE FROM memory_fts; DELETE FROM memory_chunks;")

    const memoryMdPath = path.join(this.workspaceDir, "MEMORY.md")
    if (existsSync(memoryMdPath)) {
      await this.indexMemoryFile("MEMORY.md", await fs.readFile(memoryMdPath, "utf-8"))
    }

    const memoryDir = path.join(this.workspaceDir, "memory")
    if (existsSync(memoryDir)) {
      const files = (await fs.readdir(memoryDir))
        .filter((file) => file.endsWith(".md"))
        .sort()

      for (const file of files) {
        const source = `memory/${file}`
        const content = await fs.readFile(path.join(memoryDir, file), "utf-8")
        await this.indexMemoryFile(source, content)
      }
    }

    const sessionsDir = path.join(os.homedir(), ".openceph", "agents", "ceph", "sessions")
    if (!existsSync(sessionsDir)) return

    const transcripts = (await fs.readdir(sessionsDir))
      .filter((file) => file.endsWith(".jsonl") && !file.includes(".reset."))
      .sort()

    for (const file of transcripts) {
      const sessionId = file.replace(/\.jsonl$/, "")
      const content = await fs.readFile(path.join(sessionsDir, file), "utf-8")
      await this.indexTranscript(sessionId, content)
    }
  }

  async search(
    query: string,
    options?: { topK?: number; includeTranscripts?: boolean },
  ): Promise<MemorySearchResult[]> {
    await this.initialize()
    const normalizedTerms = query
      .trim()
      .split(/\s+/)
      .map((term) => term.replace(/["']/g, "").trim())
      .filter(Boolean)

    if (normalizedTerms.length === 0) return []

    const matchQuery = normalizedTerms.map((term) => `"${term}"`).join(" OR ")
    const topK = Math.max(1, Math.floor(options?.topK ?? 5))
    const includeTranscripts = options?.includeTranscripts ?? false
    const sourceFilter = includeTranscripts ? "" : "AND memory_chunks.source NOT LIKE 'transcript:%'"
    const statement = this.db!.prepare(`
      SELECT
        memory_chunks.source as source,
        memory_chunks.section as section,
        memory_chunks.memory_id as memory_id,
        memory_chunks.chunk_text as content,
        CAST(-bm25(memory_fts) AS REAL) as score
      FROM memory_fts
      JOIN memory_chunks ON memory_chunks.id = memory_fts.rowid
      WHERE memory_fts.chunk_text MATCH ?
        ${sourceFilter}
      ORDER BY bm25(memory_fts)
      LIMIT ?
    `)

    const rows = statement.all(matchQuery, topK) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      source: String(row.source),
      section: String(row.section ?? ""),
      memoryId: row.memory_id ? String(row.memory_id) : null,
      content: String(row.content ?? ""),
      score: Number(row.score ?? 0),
    }))
  }

  private deleteSource(source: string): void {
    const rows = this.db!.prepare("SELECT id FROM memory_chunks WHERE source = ?").all(source) as Array<{ id: number }>
    for (const row of rows) {
      this.db!.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(row.id)
    }
    this.db!.prepare("DELETE FROM memory_chunks WHERE source = ?").run(source)
  }

  private insertChunks(source: string, chunks: IndexedChunk[]): void {
    const insertChunk = this.db!.prepare(`
      INSERT INTO memory_chunks (source, chunk_text, section, memory_id, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    const insertFts = this.db!.prepare(`
      INSERT INTO memory_fts (rowid, chunk_text) VALUES (?, ?)
    `)
    const now = new Date().toISOString()

    for (const chunk of chunks) {
      const result = insertChunk.run(source, chunk.chunkText, chunk.section, chunk.memoryId, now)
      insertFts.run(Number(result.lastInsertRowid), chunk.chunkText)
    }
  }
}

function parseChunksForSource(source: string, content: string): IndexedChunk[] {
  const entries = parseMemoryEntries(content)
  if (entries.length > 0) {
    return entries.map((entry) => ({
      source,
      section: entry.section,
      memoryId: entry.memoryId,
      chunkText: entry.body,
    }))
  }

  return Array.from(parseSections(content)).map(([section, sectionContent]) => ({
    source,
    section,
    memoryId: null,
    chunkText: sectionContent,
  }))
}
