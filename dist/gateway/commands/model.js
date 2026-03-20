export const modelCommand = {
    async execute(args, ctx) {
        if (args.length === 0) {
            return `Current model: ${ctx.brain.model}`;
        }
        if (args[0] === "list") {
            const primary = ctx.config.agents.defaults.model.primary;
            const fallbacks = ctx.config.agents.defaults.model.fallbacks;
            const lines = [`Primary: ${primary}`];
            if (fallbacks.length > 0) {
                lines.push(`Fallbacks: ${fallbacks.join(", ")}`);
            }
            return lines.join("\n");
        }
        if (args[0] === "status") {
            return `Model: ${ctx.brain.model}\nAPI mode: api_key`;
        }
        // Switch model
        const newModel = args[0];
        await ctx.brain.resetSession(newModel);
        return `Model switched to: ${newModel}`;
    },
};
