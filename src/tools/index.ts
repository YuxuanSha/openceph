import type { ToolDefinition } from "@mariozechner/pi-coding-agent"

export interface ToolRegistryEntry {
  name: string
  description: string
  group: string
  tool: ToolDefinition<any, any>
}

export class ToolRegistry {
  private entries: Map<string, ToolRegistryEntry> = new Map()

  register(entry: ToolRegistryEntry): void {
    this.entries.set(entry.name, entry)
  }

  getAll(): ToolRegistryEntry[] {
    return Array.from(this.entries.values())
  }

  getByGroup(group: string): ToolRegistryEntry[] {
    return this.getAll().filter((e) => e.group === group)
  }

  /** Return all tool definitions for passing to createAgentSession({ customTools }) */
  getPiTools(): ToolDefinition<any, any>[] {
    return this.getAll().map((e) => e.tool)
  }

  /** Return "name — description" list for System Prompt Section 2 */
  getToolSummary(): string {
    return this.getAll()
      .map((e) => `${e.name} — ${e.description}`)
      .join("\n")
  }

  get(name: string): ToolRegistryEntry | undefined {
    return this.entries.get(name)
  }

  get size(): number {
    return this.entries.size
  }
}
