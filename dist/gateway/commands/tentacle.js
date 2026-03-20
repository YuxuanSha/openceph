export const tentaclesCommand = {
    async execute(_args, ctx) {
        const items = ctx.brain.listTentacles();
        if (items.length === 0)
            return "No active tentacles.";
        return items.map((item) => `${item.tentacleId}  ${item.status}  ${item.pid ?? "-"}  ${item.purpose ?? "-"}`).join("\n");
    },
};
