import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createTentacleTools } from "../../src/tools/tentacle-tools.js"

describe("tentacle tools", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("lists active tentacles with runtime log and data paths", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-tentacle-tools-"))
    const logDir = path.join(baseDir, "logs")
    const tentacleDir = path.join(baseDir, "tentacles", "t_active")
    fs.mkdirSync(path.join(tentacleDir, "logs"), { recursive: true })
    fs.writeFileSync(path.join(tentacleDir, "logs", "terminal.log"), "[stdout] ok\n")
    fs.writeFileSync(path.join(tentacleDir, "sample.db"), "")

    const manager = {
      listAll: vi.fn().mockReturnValue([{
        tentacleId: "t_active",
        status: "running",
        pid: 123,
        purpose: "monitor",
        triggerSchedule: "self:2m",
        scheduleConfig: { cronJobs: [] },
      }]),
      getTentacleDir: vi.fn().mockReturnValue(tentacleDir),
      getTentacleSchedule: vi.fn(),
      setTentacleSchedule: vi.fn(),
      getCronScheduler: vi.fn().mockReturnValue(null),
    } as any

    const tools = createTentacleTools(manager, logDir, {} as any)
    const tool = tools.find((entry) => entry.name === "list_tentacles")!.tool
    const result = await tool.execute("tool-1", { status_filter: "active" })
    const text = result.content[0].text

    expect(text).toContain("t_active")
    expect(text).toContain(`log_dir=${path.join(tentacleDir, "logs")}`)
    expect(text).toContain(`terminal_log=${path.join(tentacleDir, "logs", "terminal.log")}`)
    expect(text).toContain(`data_paths=${path.join(tentacleDir, "sample.db")}`)

    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  it("normalizes update_self_schedule_config and human-readable intervals", async () => {
    const manager = {
      listAll: vi.fn().mockReturnValue([]),
      getTentacleDir: vi.fn().mockReturnValue("/tmp/t_schedule"),
      getTentacleSchedule: vi.fn().mockResolvedValue({
        primaryTrigger: { type: "self-schedule", interval: "6h" },
        cronJobs: [],
      }),
      setTentacleSchedule: vi.fn().mockResolvedValue(undefined),
      getCronScheduler: vi.fn().mockReturnValue(null),
    } as any

    const tools = createTentacleTools(manager, path.join(os.tmpdir(), "logs"), {} as any)
    const tool = tools.find((entry) => entry.name === "manage_tentacle_schedule")!.tool
    const result = await tool.execute("tool-1", {
      tentacle_id: "t_schedule",
      action: "update_self_schedule_config",
      self_schedule_config: { interval: "2 minutes" },
    })

    expect(result.content[0].text).toContain("Tentacle self schedule set: 2m")
    expect(manager.setTentacleSchedule).toHaveBeenCalledWith("t_schedule", {
      primaryTrigger: { type: "self-schedule", interval: "2m" },
      cronJobs: [],
    })
  })

  it("inspects runtime logs even when no central rotated log exists", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "openceph-tentacle-inspect-"))
    const logDir = path.join(baseDir, "logs")
    const tentacleDir = path.join(baseDir, "tentacles", "t_inspect")
    const tentacleLogsDir = path.join(tentacleDir, "logs")
    fs.mkdirSync(tentacleLogsDir, { recursive: true })
    fs.writeFileSync(path.join(tentacleLogsDir, "terminal.log"), "[stderr] boom\n[stdout] ok\n")
    fs.writeFileSync(path.join(tentacleDir, "tentacle.json"), "{}")

    const manager = {
      listAll: vi.fn().mockReturnValue([]),
      getTentacleDir: vi.fn().mockReturnValue(tentacleDir),
      getTentacleSchedule: vi.fn(),
      setTentacleSchedule: vi.fn(),
      getCronScheduler: vi.fn().mockReturnValue(null),
    } as any

    const tools = createTentacleTools(manager, logDir, {} as any)
    const tool = tools.find((entry) => entry.name === "inspect_tentacle_log")!.tool
    const result = await tool.execute("tool-1", { tentacle_id: "t_inspect", n_lines: 20 })
    const text = result.content[0].text

    expect(text).toContain(`log_dir=${tentacleLogsDir}`)
    expect(text).toContain(`terminal_log=${path.join(tentacleLogsDir, "terminal.log")}`)
    expect(text).toContain("[recent_terminal_output]")
    expect(text).toContain("[stderr] boom")
    expect(text).toContain(`data_paths=${path.join(tentacleDir, "tentacle.json")}`)

    fs.rmSync(baseDir, { recursive: true, force: true })
  })
})
