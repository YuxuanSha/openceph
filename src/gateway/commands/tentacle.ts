import type { CommandExecutor, CommandContext } from "./command-handler.js"

export const tentaclesCommand: CommandExecutor = {
  async execute(_args: string[], ctx: CommandContext): Promise<string> {
    const items = ctx.brain.listTentacles()
    if (items.length === 0) return "No active tentacles."
    return items.map((item) =>
      `${item.tentacleId}  ${item.status}  ${item.pid ?? "-"}  ${item.purpose ?? "-"}`
    ).join("\n")
  },
}
