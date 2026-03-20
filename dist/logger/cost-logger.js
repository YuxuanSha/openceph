import { createLogger } from "./create-logger.js";
import * as path from "path";
let logger = null;
export function initCostLogger(logDir, level, maxSizeMb, keepDays) {
    logger = createLogger({
        filename: path.join(logDir, "cost-%DATE%.log"),
        level,
        maxSize: `${maxSizeMb}m`,
        maxFiles: `${keepDays}d`,
    });
}
export const costLogger = {
    info(event, meta) {
        getLogger().info({ event, ...meta });
    },
    warn(event, meta) {
        getLogger().warn({ event, ...meta });
    },
    error(event, meta) {
        getLogger().error({ event, ...meta });
    },
    debug(event, meta) {
        getLogger().debug({ event, ...meta });
    },
};
function getLogger() {
    if (!logger) {
        throw new Error("Cost logger not initialized. Call initCostLogger() first.");
    }
    return logger;
}
