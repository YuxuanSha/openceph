import type { OpenCephConfig } from "../config/config-schema.js";
export declare function initLoggers(config: OpenCephConfig): void;
export { brainLogger } from "./brain-logger.js";
export { gatewayLogger } from "./gateway-logger.js";
export { systemLogger } from "./system-logger.js";
export { costLogger } from "./cost-logger.js";
export { codeAgentLogger } from "./code-agent-logger.js";
export { tentacleLog } from "./tentacle-logger.js";
export { writeCacheTrace } from "./cache-trace-logger.js";
