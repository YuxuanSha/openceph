import type { CommandExecutor, CommandContext } from "./command-handler.js"

export const newCommand: CommandExecutor = {
  async execute(args: string[], ctx: CommandContext): Promise<string> {
    const newModel = args[0] || undefined
    await ctx.brain.resetSession(newModel, ctx.sessionKey)
    return `🐙 Session reset.${newModel ? ` Model: ${newModel}` : ""} Ready for new conversation.`
  },
}

export const stopCommand: CommandExecutor = {
  async execute(_args: string[], _ctx: CommandContext): Promise<string> {
    // MessageQueue clearing is handled by the router before reaching here
    return "🛑 Stopped. Message queue cleared."
  },
}

export const compactCommand: CommandExecutor = {
  async execute(args: string[], ctx: CommandContext): Promise<string> {
    const instructions = args.join(" ").trim() || undefined
    return ctx.brain.compactSession(instructions)
  },
}
