import type { Brain } from "../../brain/brain.js"
import type { OpenCephConfig } from "../../config/config-schema.js"

export interface CommandContext {
  channel: string
  senderId: string
  sessionKey: string
  brain: Brain
  config: OpenCephConfig
}

export interface CommandExecutor {
  execute(args: string[], context: CommandContext): Promise<string>
}

export class CommandHandler {
  private commands: Map<string, CommandExecutor> = new Map()
  private aliases: Map<string, string> = new Map()

  register(command: string, executor: CommandExecutor): void {
    this.commands.set(command, executor)
  }

  registerAlias(alias: string, target: string): void {
    this.aliases.set(alias, target)
  }

  async execute(text: string, context: CommandContext): Promise<string | null> {
    const trimmed = text.trim()
    if (!trimmed.startsWith("/")) return null

    const parts = trimmed.split(/\s+/)
    let cmd = parts[0].toLowerCase()
    const args = parts.slice(1)

    // Resolve aliases
    if (this.aliases.has(cmd)) {
      cmd = this.aliases.get(cmd)!
    }

    const executor = this.commands.get(cmd)
    if (!executor) {
      // Check if it's a directive embedded in a message
      // e.g., "/model haiku 帮我分析这个问题"
      const directive = this.commands.get(cmd)
      if (!directive) return null
    }

    return executor!.execute(args, context)
  }
}
