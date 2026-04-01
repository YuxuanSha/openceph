import { existsSync } from "fs"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import archiver from "archiver"
import extract from "extract-zip"
import { createWriteStream } from "fs"
import { systemLogger, brainLogger } from "../logger/index.js"
import { SkillLoader } from "./skill-loader.js"

const DEFAULT_PACK_EXCLUDE = [
  "venv/", "node_modules/", ".git/",
  "data/", "*.db",
  ".env",
  "__pycache__/", "*.pyc",
  "tentacle.json",
  "tentacle.log",
  "deploy.log",
  "generated-code.json",
  ".openceph-prompt.md",
]

export class TentaclePackager {
  private packExclude: string[]

  constructor(packExclude?: string[]) {
    this.packExclude = packExclude ?? DEFAULT_PACK_EXCLUDE
  }

  /**
   * Pack a deployed tentacle as a shareable .tentacle (zip) file.
   * Restores personal config to placeholders, excludes runtime artifacts.
   * Output is named after the skill name from SKILL.md.
   */
  async pack(tentacleId: string, outputDir?: string): Promise<string> {
    const tentacleDir = path.join(os.homedir(), ".openceph", "tentacles", tentacleId)

    if (!existsSync(tentacleDir)) {
      throw new Error(`Tentacle directory not found: ${tentacleDir}`)
    }

    // 1. Read skill name from SKILL.md for output filename
    const skillName = await this.readSkillName(tentacleDir) ?? tentacleId
    const safeName = skillName.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()

    // 2. Restore prompt/SYSTEM.md personal config to placeholders
    await this.restorePlaceholders(tentacleDir)

    // 3. Collect files for packaging (exclude runtime artifacts)
    const files = await this.collectPackFiles(tentacleDir)

    // 4. Create .tentacle file (zip format)
    const destDir = outputDir ?? process.cwd()
    await fs.mkdir(destDir, { recursive: true })
    const outputPath = path.join(destDir, `${safeName}.tentacle`)

    await this.createZipArchive(tentacleDir, files, outputPath)

    brainLogger.info("skill_tentacle_packaged", {
      tentacle_id: tentacleId,
      skill_name: skillName,
      output_path: outputPath,
      file_count: files.length,
    })

    return outputPath
  }

  /**
   * Install a .tentacle package to the skills/ directory.
   * Supports: local .tentacle file, github:user/repo/path, local directory.
   */
  async install(source: string): Promise<string> {
    const skillsDir = path.join(os.homedir(), ".openceph", "skills")
    await fs.mkdir(skillsDir, { recursive: true })

    if (source.endsWith(".tentacle") && existsSync(source)) {
      // Local .tentacle file: extract zip to skills/
      const name = path.basename(source, ".tentacle")
      const targetDir = path.join(skillsDir, name)
      await this.extractZipArchive(source, targetDir)

      brainLogger.info("skill_tentacle_installed", { source, target: targetDir })
      systemLogger.info("skill_tentacle_discovered", { name, path: targetDir })

      return targetDir
    }

    if (source.startsWith("github:")) {
      // GitHub: parse github:user/repo/path format
      const ghPath = source.slice("github:".length)
      const parts = ghPath.split("/")
      if (parts.length < 3) {
        throw new Error(`Invalid github source format. Expected github:user/repo/path, got: ${source}`)
      }
      const user = parts[0]
      const repo = parts[1]
      const subPath = parts.slice(2).join("/")
      const name = parts[parts.length - 1]
      const targetDir = path.join(skillsDir, name)

      const { execFile } = await import("child_process")
      const tmpDir = path.join(os.tmpdir(), `openceph-install-${Date.now()}`)
      await fs.mkdir(tmpDir, { recursive: true })

      await new Promise<void>((resolve, reject) => {
        execFile("git", [
          "clone", "--depth", "1", "--filter=blob:none", "--sparse",
          `https://github.com/${user}/${repo}.git`, tmpDir,
        ], { timeout: 60_000 }, (err) => {
          if (err) reject(new Error(`Failed to clone: ${err.message}`))
          else resolve()
        })
      })

      await new Promise<void>((resolve, reject) => {
        execFile("git", ["-C", tmpDir, "sparse-checkout", "set", subPath],
          { timeout: 30_000 }, (err) => {
            if (err) reject(new Error(`Failed to sparse-checkout: ${err.message}`))
            else resolve()
          })
      })

      const srcDir = path.join(tmpDir, subPath)
      if (!existsSync(srcDir)) {
        await fs.rm(tmpDir, { recursive: true, force: true })
        throw new Error(`Path not found in repo: ${subPath}`)
      }

      await fs.cp(srcDir, targetDir, { recursive: true })
      await fs.rm(tmpDir, { recursive: true, force: true })

      brainLogger.info("skill_tentacle_installed", { source, target: targetDir })
      systemLogger.info("skill_tentacle_discovered", { name, path: targetDir })
      return targetDir
    }

    // Local directory: copy directly
    if (existsSync(source) && (await fs.stat(source)).isDirectory()) {
      const name = path.basename(source)
      const targetDir = path.join(skillsDir, name)
      await fs.cp(source, targetDir, { recursive: true })

      brainLogger.info("skill_tentacle_installed", { source, target: targetDir })
      systemLogger.info("skill_tentacle_discovered", { name, path: targetDir })
      return targetDir
    }

    throw new Error(`Unsupported install source: ${source}`)
  }

  /**
   * List all installed skill_tentacles with name, version, runtime, isSkillTentacle status.
   */
  async listInstalled(): Promise<Array<{
    name: string
    path: string
    isSkillTentacle: boolean
    version?: string
    runtime?: string
  }>> {
    const skillsDir = path.join(os.homedir(), ".openceph", "skills")
    if (!existsSync(skillsDir)) return []

    const entries = await fs.readdir(skillsDir, { withFileTypes: true })
    const results = []
    const loader = new SkillLoader([])

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillPath = path.join(skillsDir, entry.name)
      const skill = await loader.loadSingle(skillPath)
      const isSkillTentacle =
        skill?.isSkillTentacle
        || (
          existsSync(path.join(skillPath, "SKILL.md"))
          && existsSync(path.join(skillPath, "prompt", "SYSTEM.md"))
          && existsSync(path.join(skillPath, "src"))
          && existsSync(path.join(skillPath, "README.md"))
        )
      results.push({
        name: entry.name,
        path: skillPath,
        isSkillTentacle,
        version: skill?.version,
        runtime: skill?.skillTentacleConfig?.runtime ?? skill?.tentacleConfig?.runtime,
      })
    }

    return results
  }

  /**
   * Get rich info about a specific installed skill_tentacle.
   */
  async info(name: string): Promise<Record<string, unknown> | null> {
    const skillPath = path.join(os.homedir(), ".openceph", "skills", name)
    const loader = new SkillLoader([])
    const skill = await loader.loadSingle(skillPath)
    if (!skill) return null

    const tentacleConfig = skill.skillTentacleConfig ?? skill.tentacleConfig
    const customizable = (skill.skillTentacleConfig?.customizable ?? []).map((field) => ({
      field: field.field,
      description: field.description,
      type: field.envVar ? "env_var" : field.promptPlaceholder ? "prompt_placeholder" : "unknown",
    }))

    return {
      name: skill.name,
      version: skill.version,
      description: skill.description,
      isSkillTentacle: skill.isSkillTentacle,
      runtime: tentacleConfig?.runtime ?? "python",
      requires: tentacleConfig?.requires ?? { bins: [], env: [] },
      capabilities: skill.skillTentacleConfig?.capabilities ?? [],
      customizable,
      path: skillPath,
    }
  }

  // ── Private helpers ──

  private async readSkillName(tentacleDir: string): Promise<string | undefined> {
    const skillMdPath = path.join(tentacleDir, "SKILL.md")
    if (!existsSync(skillMdPath)) return undefined
    try {
      const content = await fs.readFile(skillMdPath, "utf-8")
      return content.match(/^name:\s*(.+)/m)?.[1]?.trim()
    } catch {
      return undefined
    }
  }

  private async restorePlaceholders(tentacleDir: string): Promise<void> {
    const systemMdPath = path.join(tentacleDir, "prompt", "SYSTEM.md")
    if (!existsSync(systemMdPath)) return

    const tentacleJsonPath = path.join(tentacleDir, "tentacle.json")
    if (!existsSync(tentacleJsonPath)) return

    let tentacleJson: Record<string, unknown>
    try {
      tentacleJson = JSON.parse(await fs.readFile(tentacleJsonPath, "utf-8"))
    } catch {
      return
    }

    const mapping = tentacleJson.placeholderMapping as Record<string, string> | undefined
    if (!mapping || Object.keys(mapping).length === 0) return

    let content = await fs.readFile(systemMdPath, "utf-8")

    // Reverse-substitute: replace injected values back to placeholder keys
    for (const [placeholder, value] of Object.entries(mapping)) {
      if (value && value.trim()) {
        content = content.split(value).join(placeholder)
      }
    }

    await fs.writeFile(systemMdPath, content, "utf-8")
  }

  private async collectPackFiles(dir: string): Promise<string[]> {
    const files: string[] = []
    await this.walkForPack(dir, dir, files)
    return files
  }

  private async walkForPack(root: string, dir: string, files: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relPath = path.relative(root, fullPath)

      if (this.shouldExclude(relPath, entry.isDirectory())) continue

      if (entry.isDirectory()) {
        await this.walkForPack(root, fullPath, files)
      } else {
        files.push(relPath)
      }
    }
  }

  private shouldExclude(relPath: string, isDir: boolean): boolean {
    for (const pattern of this.packExclude) {
      if (pattern.endsWith("/")) {
        const dirName = pattern.slice(0, -1)
        if (isDir && (relPath === dirName || relPath.startsWith(dirName + "/"))) return true
        if (relPath.includes("/" + dirName + "/") || relPath.startsWith(dirName + "/")) return true
      } else if (pattern.startsWith("*.")) {
        const ext = pattern.slice(1)
        if (relPath.endsWith(ext)) return true
      } else {
        if (path.basename(relPath) === pattern) return true
      }
    }
    return false
  }

  private async createZipArchive(baseDir: string, files: string[], outputPath: string): Promise<void> {
    const pkgName = path.basename(outputPath, ".tentacle")

    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(outputPath)
      const archive = archiver("zip", { zlib: { level: 9 } })

      output.on("close", resolve)
      archive.on("error", reject)
      archive.pipe(output)

      for (const file of files) {
        archive.file(path.join(baseDir, file), { name: path.join(pkgName, file) })
      }

      archive.finalize()
    })
  }

  private async extractZipArchive(archivePath: string, targetDir: string): Promise<void> {
    await fs.mkdir(targetDir, { recursive: true })

    const tmpDir = path.join(os.tmpdir(), `openceph-extract-${Date.now()}`)
    await fs.mkdir(tmpDir, { recursive: true })

    try {
      // Try zip extraction first (new .tentacle format)
      try {
        await extract(archivePath, { dir: tmpDir })
      } catch {
        // Fallback: try tar for .tentacle archive files
        const { execFile } = await import("child_process")
        await new Promise<void>((resolve, reject) => {
          execFile("tar", ["-xzf", archivePath, "-C", tmpDir], { timeout: 30_000 }, (err) => {
            if (err) reject(new Error(`Failed to extract archive: ${err.message}`))
            else resolve()
          })
        })
      }

      // Find the extracted directory (may be wrapped in a subdirectory)
      const extracted = await fs.readdir(tmpDir)
      if (extracted.length === 1) {
        const srcDir = path.join(tmpDir, extracted[0])
        const stat = await fs.stat(srcDir)
        if (stat.isDirectory()) {
          await fs.cp(srcDir, targetDir, { recursive: true })
        } else {
          await fs.cp(tmpDir, targetDir, { recursive: true })
        }
      } else {
        await fs.cp(tmpDir, targetDir, { recursive: true })
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }
}
