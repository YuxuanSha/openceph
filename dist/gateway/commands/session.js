export const newCommand = {
    async execute(args, ctx) {
        const newModel = args[0] || undefined;
        await ctx.brain.resetSession(newModel, ctx.sessionKey);
        return `🐙 Session reset.${newModel ? ` Model: ${newModel}` : ""} Ready for new conversation.`;
    },
};
export const stopCommand = {
    async execute(_args, _ctx) {
        // MessageQueue clearing is handled by the router before reaching here
        return "🛑 Stopped. Message queue cleared.";
    },
};
export const compactCommand = {
    async execute(args, ctx) {
        const instructions = args.join(" ").trim() || undefined;
        return ctx.brain.compactSession(instructions);
    },
};
