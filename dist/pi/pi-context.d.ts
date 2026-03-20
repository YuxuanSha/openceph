import { AuthStorage, ModelRegistry, DefaultResourceLoader, SettingsManager } from "@mariozechner/pi-coding-agent";
import type { OpenCephConfig } from "../config/config-schema.js";
export interface PiContext {
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
    resourceLoader: DefaultResourceLoader;
    settingsManager: SettingsManager;
    agentDir: string;
    workspaceDir: string;
}
export declare function createPiContext(config: OpenCephConfig): Promise<PiContext>;
