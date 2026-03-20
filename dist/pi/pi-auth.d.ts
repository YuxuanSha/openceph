import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { OpenCephConfig } from "../config/config-schema.js";
/**
 * Inject API keys from config.auth.profiles into Pi's AuthStorage.
 * Runtime-only — not persisted to auth.json.
 */
export declare function injectApiKeys(authStorage: AuthStorage, config: OpenCephConfig): void;
