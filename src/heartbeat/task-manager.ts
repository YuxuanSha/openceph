import * as fs from "fs/promises"
import { existsSync } from "fs"
import * as path from "path"

export interface HeartbeatTask {
  text: string
  schedule: "daily" | "weekly" | "once"
  section: string
  completed: boolean
  lineNumber: number
}

export class HeartbeatTaskManager {
  private heartbeatPath: string

  constructor(private workspaceDir: string) {
    this.heartbeatPath = path.join(workspaceDir, "HEARTBEAT.md")
  }

  async readTasks(): Promise<HeartbeatTask[]> {
    const content = await this.readOrInit()
    const tasks: HeartbeatTask[] = []
    let currentSection = "Pending"

    for (const [index, line] of content.split("\n").entries()) {
      const sectionMatch = line.match(/^## (.+)$/)
      if (sectionMatch) {
        currentSection = sectionMatch[1]
        continue
      }

      const taskMatch = line.match(/^- \[([ x])\] (.+)$/)
      if (!taskMatch) continue

      tasks.push({
        text: taskMatch[2].replace(/\s+\(notes:.*\)$/, ""),
        schedule: inferSchedule(currentSection),
        section: currentSection,
        completed: taskMatch[1] === "x",
        lineNumber: index + 1,
      })
    }

    return tasks
  }

  async completeTask(taskDescription: string, notes?: string): Promise<void> {
    const content = await this.readOrInit()
    const lines = content.split("\n")
    const index = lines.findIndex((line) => line.trim() === `- [ ] ${taskDescription}`)
    if (index === -1) {
      throw new Error(`Task not found: ${taskDescription}`)
    }
    lines[index] = `- [x] ${taskDescription}${notes ? ` (notes: ${notes})` : ""}`
    await fs.writeFile(this.heartbeatPath, lines.join("\n"), "utf-8")
  }

  async addTask(
    task: string,
    schedule: "daily" | "weekly" | "once",
    section?: string,
  ): Promise<void> {
    const content = await this.readOrInit()
    const lines = content.split("\n")
    const targetSection = section ?? defaultSectionForSchedule(schedule)
    const heading = `## ${targetSection}`
    const sectionIndex = lines.findIndex((line) => line === heading)

    if (sectionIndex === -1) {
      lines.push("", heading, `- [ ] ${task}`)
    } else {
      let insertAt = sectionIndex + 1
      while (insertAt < lines.length && !lines[insertAt].startsWith("## ")) {
        insertAt++
      }
      lines.splice(insertAt, 0, `- [ ] ${task}`)
    }

    await fs.writeFile(this.heartbeatPath, lines.join("\n"), "utf-8")
  }

  async resetRecurringTasks(): Promise<void> {
    const content = await this.readOrInit()
    const lines = content.split("\n")
    let currentSection = ""
    const next = lines.map((line) => {
      const sectionMatch = line.match(/^## (.+)$/)
      if (sectionMatch) {
        currentSection = sectionMatch[1]
        return line
      }

      if (/^- \[x\] /.test(line) && (currentSection === "Daily Tasks" || currentSection === "Weekly Tasks")) {
        return line.replace("- [x] ", "- [ ] ").replace(/\s+\(notes:.*\)$/, "")
      }

      return line
    })

    await fs.writeFile(this.heartbeatPath, next.join("\n"), "utf-8")
  }

  private async readOrInit(): Promise<string> {
    if (!existsSync(this.heartbeatPath)) {
      await fs.mkdir(this.workspaceDir, { recursive: true })
      await fs.writeFile(this.heartbeatPath, "# HEARTBEAT.md\n\n## Daily Tasks\n\n## Weekly Tasks\n\n## Pending\n", "utf-8")
    }
    return fs.readFile(this.heartbeatPath, "utf-8")
  }
}

function defaultSectionForSchedule(schedule: "daily" | "weekly" | "once"): string {
  if (schedule === "daily") return "Daily Tasks"
  if (schedule === "weekly") return "Weekly Tasks"
  return "Pending"
}

function inferSchedule(section: string): "daily" | "weekly" | "once" {
  if (section === "Daily Tasks") return "daily"
  if (section === "Weekly Tasks") return "weekly"
  return "once"
}
