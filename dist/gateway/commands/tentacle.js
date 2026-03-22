import * as fs from "fs/promises";
import * as path from "path";
export const tentaclesCommand = {
    async execute(_args, ctx) {
        const items = ctx.brain.listTentacles();
        if (items.length === 0)
            return "No active tentacles.";
        return items.map((item) => `${item.tentacleId}  ${item.status}  ${item.pid ?? "-"}  ${item.purpose ?? "-"}  trigger=${item.triggerSchedule ?? "-"}  cron=${item.scheduleConfig?.cronJobs?.length ?? 0}  hb=${item.scheduleConfig?.heartbeat?.enabled ? item.scheduleConfig.heartbeat.every : "off"}`).join("\n");
    },
};
export const tentacleCommand = {
    async execute(args, ctx) {
        const action = args[0];
        const tentacleId = args[1];
        if (!action)
            return "Usage: /tentacle [status|pause|resume|weaken|kill|run|schedule] <id>";
        if (action === "status" || action === "schedule") {
            if (!tentacleId)
                return `Usage: /tentacle ${action} <id>`;
            const item = ctx.brain.listTentacles().find((entry) => entry.tentacleId === tentacleId);
            if (!item)
                return `Tentacle not found: ${tentacleId}`;
            const logLines = await readTentacleLogTail(ctx.config.logging.logDir, tentacleId, 10);
            return [
                `${item.tentacleId}`,
                `status=${item.status}`,
                `pid=${item.pid ?? "-"}`,
                `purpose=${item.purpose ?? "-"}`,
                `trigger=${item.triggerSchedule ?? "-"}`,
                `schedule=${item.scheduleConfig ? JSON.stringify(item.scheduleConfig) : "-"}`,
                `recent_log=${logLines.length > 0 ? "" : "none"}`,
                ...logLines.map((line) => `- ${line}`),
            ].join("\n");
        }
        if (!tentacleId)
            return `Usage: /tentacle ${action} <id>`;
        const manager = ctx.brain.tentacleManager;
        if (!manager)
            return "Tentacle manager unavailable.";
        if (action === "pause") {
            return (await manager.pause(tentacleId)) ? `Paused: ${tentacleId}` : `Pause failed: ${tentacleId}`;
        }
        if (action === "resume") {
            return (await manager.resume(tentacleId)) ? `Resumed: ${tentacleId}` : `Resume failed: ${tentacleId}`;
        }
        if (action === "weaken") {
            return (await manager.weaken(tentacleId, "command")) ? `Weakened: ${tentacleId}` : `Weaken failed: ${tentacleId}`;
        }
        if (action === "kill") {
            return (await manager.kill(tentacleId, "command")) ? `Killed: ${tentacleId}` : `Kill failed: ${tentacleId}`;
        }
        if (action === "run") {
            return (await manager.runNow(tentacleId)) ? `Triggered: ${tentacleId}` : `Run failed: ${tentacleId}`;
        }
        return "Usage: /tentacle [status|pause|resume|weaken|kill|run|schedule] <id>";
    },
};
async function readTentacleLogTail(logDir, tentacleId, lines) {
    try {
        const files = (await fs.readdir(logDir))
            .filter((file) => file.startsWith(`tentacle-${tentacleId}-`))
            .sort();
        const file = files.at(-1);
        if (!file)
            return [];
        const content = await fs.readFile(path.join(logDir, file), "utf-8");
        return content.trim().split("\n").slice(-lines);
    }
    catch {
        return [];
    }
}
