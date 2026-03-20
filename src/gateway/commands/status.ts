import type { CommandExecutor, CommandContext } from "./command-handler.js"

export const statusCommand: CommandExecutor = {
  async execute(_args: string[], ctx: CommandContext): Promise<string> {
    const status = ctx.brain.getSessionStatus()
    return [
      `📊 Session Status`,
      `  Model: ${status.model}`,
      `  Session: ${status.sessionKey}`,
      `  Tokens: ${status.inputTokens} in / ${status.outputTokens} out`,
      `  Active tentacles: ${status.activeTentacles}`,
      `  Today cost: $${status.todayCostUsd.toFixed(4)}`,
    ].join("\n")
  },
}

export const whoamiCommand: CommandExecutor = {
  async execute(_args: string[], ctx: CommandContext): Promise<string> {
    return `Channel: ${ctx.channel}\nSender: ${ctx.senderId}`
  },
}
