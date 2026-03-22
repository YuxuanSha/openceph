import { createAgentSession, SessionManager, } from "@mariozechner/pi-coding-agent";
import { getModels } from "@mariozechner/pi-ai";
export async function createBrainSession(piCtx, config, options) {
    const modelId = options.modelId ?? config.agents.defaults.model.primary;
    const [provider, ...rest] = modelId.split("/");
    const id = rest.join("/");
    // Try custom provider first, then built-in
    // getModel is strictly typed for known provider/model combos,
    // so we use getModels to find by id for dynamic strings
    let model = piCtx.modelRegistry.find(provider, id);
    if (!model) {
        try {
            const builtinModels = getModels(provider);
            model = builtinModels.find((m) => m.id === id) ?? undefined;
        }
        catch {
            // provider not known
        }
    }
    if (!model) {
        throw new Error(`Model not found: ${modelId}. Check auth.profiles and models.providers in openceph.json`);
    }
    const sessionManager = SessionManager.open(options.sessionFilePath);
    const { session } = await createAgentSession({
        cwd: piCtx.workspaceDir,
        agentDir: piCtx.agentDir,
        authStorage: piCtx.authStorage,
        modelRegistry: piCtx.modelRegistry,
        model,
        thinkingLevel: options.thinkingLevel ?? "off",
        tools: [],
        customTools: options.customTools ?? [],
        sessionManager,
        settingsManager: piCtx.settingsManager,
        resourceLoader: piCtx.resourceLoader,
    });
    let lastReplyText = "";
    session.subscribe((event) => {
        if (event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta") {
            lastReplyText += event.assistantMessageEvent.delta;
        }
    });
    return {
        session,
        async prompt(text) {
            lastReplyText = "";
            await session.prompt(text);
            return lastReplyText;
        },
        lastReply() {
            return lastReplyText || undefined;
        },
    };
}
