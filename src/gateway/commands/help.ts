import type { CommandExecutor, CommandContext } from "./command-handler.js"

export const helpCommand: CommandExecutor = {
  async execute(_args: string[], _ctx: CommandContext): Promise<string> {
    return [
      "🐙 OpenCeph Commands",
      "",
      "/new [model]  — Reset session (optionally switch model)",
      "/reset        — Alias for /new",
      "/stop         — Clear message queue and stop current request",
      "/status       — Show session status and token usage",
      "/whoami       — Show your sender ID",
      "/model        — Show current model",
      "/model <name> — Switch model",
      "/model list   — List available models",
      "/think <level> [message] — Set thinking level or use it for one reply",
      "/reasoning [on|off] — Toggle reasoning summaries in replies",
      "/compact [instructions] — Manually compact the current session",
      "/cron list    — List cron jobs",
      "/cron status <id> — Show cron job details",
      "/context list — Show workspace files, skills, and tools",
      "/context detail [file] — Show one workspace file",
      "/skill <name> [input] — Load a skill or run it as prompt context",
      "/tentacles    — Show active tentacles",
      "/tentacle <action> <id> — Manage one tentacle",
      "/help         — This help message",
    ].join("\n")
  },
}
