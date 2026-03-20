import { AuthStorage, ModelRegistry, DefaultResourceLoader, SettingsManager, } from "@mariozechner/pi-coding-agent";
import { injectApiKeys } from "./pi-auth.js";
import { writeModelsJson } from "./pi-models.js";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export async function createPiContext(config) {
    const agentDir = path.join(os.homedir(), ".openceph", "brain");
    const workspaceDir = config.agents.defaults.workspace;
    // Ensure agent dir exists
    await fs.mkdir(agentDir, { recursive: true });
    // 1. AuthStorage
    const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
    // 2. Inject API keys from config
    injectApiKeys(authStorage, config);
    // 3. ModelRegistry
    const modelsJsonPath = path.join(agentDir, "models.json");
    const modelRegistry = new ModelRegistry(authStorage, modelsJsonPath);
    // 4. Write custom provider config to models.json and reload registry
    await writeModelsJson(modelsJsonPath, config);
    modelRegistry.refresh();
    // 5. SettingsManager (private constructor — use static factory)
    const settingsManager = SettingsManager.create(workspaceDir, agentDir);
    // 6. DefaultResourceLoader with M1 extensions
    const extensionsDir = path.join(__dirname, "..", "brain", "extensions");
    const extensionPaths = [
        path.join(extensionsDir, "memory-injector.js"),
        path.join(extensionsDir, "context-pruner.js"),
        path.join(extensionsDir, "compaction-guard.js"),
    ];
    const resourceLoader = new DefaultResourceLoader({
        cwd: workspaceDir,
        agentDir,
        settingsManager,
        additionalExtensionPaths: extensionPaths,
    });
    await resourceLoader.reload();
    return { authStorage, modelRegistry, resourceLoader, settingsManager, agentDir, workspaceDir };
}
