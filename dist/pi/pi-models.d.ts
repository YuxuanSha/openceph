import type { OpenCephConfig } from "../config/config-schema.js";
/**
 * Generate Pi's models.json from config.models.providers.
 * Models are placed inside each provider (Pi's expected format).
 * Skips write if content is unchanged.
 */
export declare function writeModelsJson(modelsJsonPath: string, config: OpenCephConfig): Promise<void>;
