import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { MemoryManager } from "../../src/memory/memory-manager.js"

describe("MemoryManager", () => {
  let dir: string
  let manager: MemoryManager

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-memory-test-"))
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "# MEMORY\n")
    manager = new MemoryManager(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("supports write search update delete lifecycle", async () => {
    const memoryId = await manager.writeMemory("Likes oolong tea", "User preference", ["drink"])

    const searchResults = await manager.searchMemory("oolong")
    expect(searchResults.length).toBeGreaterThan(0)
    expect(searchResults[0].memoryId).toBe(memoryId)

    await manager.distillMemory(new Date().toISOString().slice(0, 10))
    let memoryMd = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf-8")
    expect(memoryMd).toContain(memoryId)
    expect(memoryMd).toContain("Likes oolong tea")

    await manager.updateMemory(memoryId, "Likes cold-brewed oolong tea")
    memoryMd = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf-8")
    expect(memoryMd).toContain("Likes cold-brewed oolong tea")

    await manager.deleteMemory(memoryId)
    memoryMd = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf-8")
    expect(memoryMd).not.toContain(memoryId)
  })
})
