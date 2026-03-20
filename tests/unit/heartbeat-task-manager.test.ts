import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { HeartbeatTaskManager } from "../../src/heartbeat/task-manager.js"

describe("HeartbeatTaskManager", () => {
  let dir: string
  let manager: HeartbeatTaskManager

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-heartbeat-test-"))
    fs.writeFileSync(path.join(dir, "HEARTBEAT.md"), "# HEARTBEAT.md\n\n## 待处理\n", "utf-8")
    manager = new HeartbeatTaskManager(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("creates and completes tasks", async () => {
    await manager.addTask("监控 Anthropic 更新", "once")
    let tasks = await manager.readTasks()
    expect(tasks.some((task) => task.text === "监控 Anthropic 更新")).toBe(true)

    await manager.completeTask("监控 Anthropic 更新", "done")
    tasks = await manager.readTasks()
    expect(tasks.find((task) => task.text === "监控 Anthropic 更新")?.completed).toBe(true)
  })
})
