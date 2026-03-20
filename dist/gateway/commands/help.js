export const helpCommand = {
    async execute(_args, _ctx) {
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
            "/tentacles    — Show active tentacles",
            "/help         — This help message",
        ].join("\n");
    },
};
