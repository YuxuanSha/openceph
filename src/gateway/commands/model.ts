import type { CommandExecutor, CommandContext } from "./command-handler.js"

export const modelCommand: CommandExecutor = {
  async execute(args: string[], ctx: CommandContext): Promise<string> {
    if (args.length === 0) {
      return `Current model: ${await ctx.brain.getSelectedModel(ctx.sessionKey)}`
    }

    if (args[0] === "list") {
      const primary = ctx.config.agents.defaults.model.primary
      const fallbacks = ctx.config.agents.defaults.model.fallbacks
      const lines = [`Primary: ${primary}`]
      if (fallbacks.length > 0) {
        lines.push(`Fallbacks: ${fallbacks.join(", ")}`)
      }
      return lines.join("\n")
    }

    if (args[0] === "status") {
      return `Model: ${await ctx.brain.getSelectedModel(ctx.sessionKey)}\nAPI mode: api_key`
    }

    // Switch model
    const newModel = args[0]
    await ctx.brain.resetSession(newModel, ctx.sessionKey)
    return `Model switched to: ${newModel}`
  },
}

export const thinkCommand: CommandExecutor = {
  async execute(args: string[], ctx: CommandContext): Promise<string> {
    if (args.length === 0) {
      return `Current thinking: ${ctx.brain.thinkingLevel}`
    }

    const level = args[0]
    const inlineMessage = args.slice(1).join(" ").trim()
    if (!inlineMessage) {
      const applied = ctx.brain.setThinkingLevel(level)
      return `Thinking level set to: ${applied}`
    }

    const output = await ctx.brain.handleMessage({
      text: inlineMessage,
      channel: ctx.channel,
      senderId: ctx.senderId,
      sessionKey: ctx.sessionKey,
      isDm: true,
      thinkingLevelOverride: ctx.brain.setThinkingLevel(level),
    })
    return output.text || "[No response]"
  },
}

export const reasoningCommand: CommandExecutor = {
  async execute(args: string[], ctx: CommandContext): Promise<string> {
    if (args.length === 0) {
      return `Reasoning output: ${ctx.brain.reasoningMode ? "on" : "off"}`
    }
    if (args[0] !== "on" && args[0] !== "off") {
      return "Usage: /reasoning [on|off]"
    }
    ctx.brain.setReasoningEnabled(args[0] === "on")
    return `Reasoning output ${args[0]}.`
  },
}
