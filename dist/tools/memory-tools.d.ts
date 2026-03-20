import type { ToolRegistryEntry } from "./index.js";
import type { PiContext } from "../pi/pi-context.js";
import type { OpenCephConfig } from "../config/config-schema.js";
declare function createMemoryTools(options: {
    workspaceDir: string;
    piCtx?: PiContext;
    config?: OpenCephConfig;
}): ToolRegistryEntry[];
export { createMemoryTools };
