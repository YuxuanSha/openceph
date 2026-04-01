import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"

export interface WorkspaceFile {
  name: string
  path: string
  content: string
  originalLength: number
  truncated: boolean
}

/** Read workspace files with per-file and total character limits */
export async function loadWorkspaceFiles(
  workspaceDir: string,
  fileNames: string[],
  maxCharsPerFile: number,
  totalMaxChars: number,
): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = []
  let totalChars = 0

  for (const name of fileNames) {
    const filePath = path.join(workspaceDir, name)
    try {
      const raw = await fs.readFile(filePath, "utf-8")
      const originalLength = raw.length
      let content = raw
      let truncated = false

      // Per-file limit
      if (content.length > maxCharsPerFile) {
        content = content.slice(0, maxCharsPerFile) + `\n<!-- truncated at ${maxCharsPerFile} chars -->\n`
        truncated = true
      }

      // Total limit
      if (totalChars + content.length > totalMaxChars) {
        const remaining = totalMaxChars - totalChars
        if (remaining > 200) {
          content = content.slice(0, remaining) + `\n<!-- truncated: total limit reached -->\n`
          truncated = true
        } else {
          // Skip this file entirely
          continue
        }
      }

      totalChars += content.length
      files.push({ name, path: filePath, content, originalLength, truncated })
    } catch {
      // File doesn't exist — skip with warning (caller logs)
    }
  }

  return files
}

/**
 * Load identity files for a specific scene.
 * Looks in identities/{scene}/ first, falls back to workspace root.
 */
export async function loadIdentityFiles(
  workspaceDir: string,
  scene: string,
  fileNames: string[],
  maxCharsPerFile: number = 20_000,
  totalMaxChars: number = 150_000,
): Promise<WorkspaceFile[]> {
  const identityDir = path.join(workspaceDir, "identities", scene)
  const hasIdentityDir = existsSync(identityDir)

  // Resolve file paths: identity dir first, fallback to workspace root
  const resolvedNames: Array<{ name: string; filePath: string }> = fileNames.map((name) => {
    if (hasIdentityDir) {
      const scenePath = path.join(identityDir, name)
      if (existsSync(scenePath)) {
        return { name, filePath: scenePath }
      }
    }
    return { name, filePath: path.join(workspaceDir, name) }
  })

  const files: WorkspaceFile[] = []
  let totalChars = 0

  for (const { name, filePath } of resolvedNames) {
    try {
      const raw = await fs.readFile(filePath, "utf-8")
      const originalLength = raw.length
      let content = raw
      let truncated = false

      if (content.length > maxCharsPerFile) {
        content = content.slice(0, maxCharsPerFile) + `\n<!-- truncated at ${maxCharsPerFile} chars -->\n`
        truncated = true
      }

      if (totalChars + content.length > totalMaxChars) {
        const remaining = totalMaxChars - totalChars
        if (remaining > 200) {
          content = content.slice(0, remaining) + `\n<!-- truncated: total limit reached -->\n`
          truncated = true
        } else {
          continue
        }
      }

      totalChars += content.length
      files.push({ name, path: filePath, content, originalLength, truncated })
    } catch {
      // File doesn't exist — skip
    }
  }

  return files
}

/** Check if this is a first-run workspace (BOOTSTRAP.md exists + USER.md is default template) */
export async function isNewWorkspace(workspaceDir: string): Promise<boolean> {
  const bootstrapPath = path.join(workspaceDir, "BOOTSTRAP.md")
  const userPath = path.join(workspaceDir, "USER.md")

  if (!existsSync(bootstrapPath)) return false

  try {
    const userContent = await fs.readFile(userPath, "utf-8")
    // Check if USER.md still has the template placeholder
    return userContent.includes("{{") || userContent.includes("please answer the following") || userContent.includes("please answer below") || userContent.length < 200
  } catch {
    return true // No USER.md means new workspace
  }
}
