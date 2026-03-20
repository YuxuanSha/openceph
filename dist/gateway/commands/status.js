export const statusCommand = {
    async execute(_args, ctx) {
        const status = ctx.brain.getSessionStatus();
        return [
            `📊 Session Status`,
            `  Model: ${status.model}`,
            `  Session: ${status.sessionKey}`,
            `  Tokens: ${status.inputTokens} in / ${status.outputTokens} out`,
            `  Active tentacles: ${status.activeTentacles}`,
            `  Today cost: $${status.todayCostUsd.toFixed(4)}`,
        ].join("\n");
    },
};
export const whoamiCommand = {
    async execute(_args, ctx) {
        return `Channel: ${ctx.channel}\nSender: ${ctx.senderId}`;
    },
};
