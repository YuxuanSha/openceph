/**
 * Markdown memory file parser and serializer.
 */

/** Parse markdown content into sections by ## headings */
export function parseSections(content: string): Map<string, string> {
  const sections = new Map<string, string>()
  const lines = content.split("\n")
  let currentSection = ""
  let currentContent: string[] = []

  for (const line of lines) {
    const match = line.match(/^## (.+)$/)
    if (match) {
      if (currentSection) {
        sections.set(currentSection, currentContent.join("\n").trim())
      }
      currentSection = match[1]
      currentContent = []
    } else {
      currentContent.push(line)
    }
  }

  if (currentSection) {
    sections.set(currentSection, currentContent.join("\n").trim())
  }

  return sections
}

/** Replace a section's content while preserving other sections. */
export function updateSection(content: string, sectionName: string, newContent: string): string {
  const lines = content.split("\n")
  const result: string[] = []
  let inTargetSection = false
  let sectionFound = false

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^## (.+)$/)
    if (match) {
      if (inTargetSection) {
        // End of target section — insert new content before this heading
        inTargetSection = false
      }
      if (match[1] === sectionName) {
        sectionFound = true
        inTargetSection = true
        result.push(lines[i]) // Keep the heading
        result.push(newContent)
        continue
      }
    }
    if (!inTargetSection) {
      result.push(lines[i])
    }
  }

  // If we were still in the target section at EOF, content was already added
  // If section not found, append it
  if (!sectionFound) {
    result.push("")
    result.push(`## ${sectionName}`)
    result.push(newContent)
  }

  return result.join("\n")
}

/** Append content to a section, creating the section if needed. */
export function appendToSection(content: string, sectionName: string, newEntry: string): string {
  const sections = parseSections(content)
  const existing = sections.get(sectionName)
  const merged = existing?.trim()
    ? `${existing.trimEnd()}\n\n${newEntry.trim()}`
    : newEntry.trim()
  return updateSection(content, sectionName, merged)
}

/** Generate a stable daily memory ID. */
export function generateMemoryId(date: string, existingContent: string): string {
  const prefix = `mem:${date}-`
  const matches = Array.from(existingContent.matchAll(/<!--\s*mem:(\d{4}-\d{2}-\d{2})-(\d{3})\s*-->/g))
    .filter((match) => match[1] === date)
    .map((match) => Number.parseInt(match[2], 10))
    .filter((value) => Number.isFinite(value))
  const next = (matches.length === 0 ? 1 : Math.max(...matches) + 1).toString().padStart(3, "0")
  return `${prefix}${next}`
}

export interface ParsedMemoryEntry {
  section: string
  memoryId: string
  block: string
  body: string
}

/** Parse markdown memory entries grouped by section. */
export function parseMemoryEntries(content: string): ParsedMemoryEntry[] {
  const entries: ParsedMemoryEntry[] = []
  const lines = content.split("\n")
  let currentSection = ""
  let i = 0

  while (i < lines.length) {
    const sectionMatch = lines[i].match(/^## (.+)$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1]
      i++
      continue
    }

    const markerMatch = lines[i].match(/^<!--\s*mem:(\d{4}-\d{2}-\d{2}-\d{3})\s*-->$/)
    if (markerMatch && currentSection) {
      const start = i
      i++
      while (
        i < lines.length &&
        !lines[i].match(/^<!--\s*mem:/) &&
        !lines[i].match(/^## /)
      ) {
        i++
      }
      const blockLines = lines.slice(start, i)
      const body = blockLines.slice(1).join("\n").trim()
      entries.push({
        section: currentSection,
        memoryId: `mem:${markerMatch[1]}`,
        block: blockLines.join("\n").trim(),
        body,
      })
      continue
    }

    i++
  }

  return entries
}

/** Find a memory entry by its ID marker in content */
export function findMemoryById(
  content: string,
  memoryId: string,
): { start: number; end: number; text: string } | null {
  const normalized = normalizeMemoryId(memoryId)
  const marker = `<!-- ${normalized} -->`
  const lines = content.split("\n")
  let startLine = -1

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(marker)) {
      startLine = i
      break
    }
  }

  if (startLine === -1) return null

  // Find the end: next marker, next heading, or EOF
  let endLine = startLine + 1
  while (endLine < lines.length) {
    if (lines[endLine].match(/^<!-- mem:/) || lines[endLine].match(/^## /)) {
      break
    }
    endLine++
  }

  // Trim trailing empty lines
  while (endLine > startLine + 1 && lines[endLine - 1].trim() === "") {
    endLine--
  }

  const text = lines.slice(startLine, endLine).join("\n")
  return { start: startLine, end: endLine, text }
}

/** Replace a memory entry's content by ID */
export function replaceMemoryById(content: string, memoryId: string, newText: string): string {
  const found = findMemoryById(content, memoryId)
  if (!found) return content

  const lines = content.split("\n")
  const marker = `<!-- ${normalizeMemoryId(memoryId)} -->`
  const replacement = [marker, newText]
  lines.splice(found.start, found.end - found.start, ...replacement)
  return lines.join("\n")
}

/** Delete a memory entry by ID */
export function deleteMemoryById(content: string, memoryId: string): string {
  const found = findMemoryById(content, memoryId)
  if (!found) return content

  const lines = content.split("\n")
  lines.splice(found.start, found.end - found.start)
  return lines.join("\n")
}

export function normalizeMemoryId(memoryId: string): string {
  return memoryId.startsWith("mem:") ? memoryId : `mem:${memoryId}`
}
