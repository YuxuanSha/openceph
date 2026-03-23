import { createLogger } from "./create-logger.js";
import * as path from "path";
import { getAgentLogsDir } from "./log-paths.js";
let logger = null;
export function initGatewayLogger(logDir, level, maxSizeMb, keepDays) {
    const gatewayLogDir = getAgentLogsDir(logDir, "gateway");
    logger = createLogger({
        filename: path.join(gatewayLogDir, "events-%DATE%.log"),
        level,
        maxSize: `${maxSizeMb}m`,
        maxFiles: `${keepDays}d`,
    });
}
export const gatewayLogger = {
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
        throw new Error("Gateway logger not initialized. Call initGatewayLogger() first.");
    }
    return logger;
}
