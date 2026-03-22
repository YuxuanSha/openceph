import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent"
import type { ThinkingLevel } from "@mariozechner/pi-agent-core"
import { getModels, type KnownProvider } from "@mariozechner/pi-ai"
import type { PiContext } from "./pi-context.js"
import type { OpenCephConfig } from "../config/config-schema.js"

export interface BrainSessionOptions {
  sessionFilePath: string
  modelId?: string
  systemPrompt?: string
  customTools?: import("@mariozechner/pi-coding-agent").ToolDefinition<any, any>[]
  thinkingLevel?: ThinkingLevel
}

export interface BrainSession {
  session: AgentSession
  prompt(text: string): Promise<string>
  lastReply(): string | undefined
}

export async function createBrainSession(
  piCtx: PiContext,
  config: OpenCephConfig,
  options: BrainSessionOptions,
): Promise<BrainSession> {
  const modelId = options.modelId ?? config.agents.defaults.model.primary
  const [provider, ...rest] = modelId.split("/")
  const id = rest.join("/")

  // Try custom provider first, then built-in
  // getModel is strictly typed for known provider/model combos,
  // so we use getModels to find by id for dynamic strings
  let model: any = piCtx.modelRegistry.find(provider, id)
  if (!model) {
    try {
      const builtinModels = getModels(provider as KnownProvider)
      model = builtinModels.find((m: any) => m.id === id) ?? undefined
    } catch {
      // provider not known
    }
  }

  if (!model) {
    throw new Error(`Model not found: ${modelId}. Check auth.profiles and models.providers in openceph.json`)
  }

  const sessionManager = SessionManager.open(options.sessionFilePath)

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
  })

  let lastReplyText = ""

  session.subscribe((event: any) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      lastReplyText += event.assistantMessageEvent.delta
    }
  })

  return {
    session,
    async prompt(text: string): Promise<string> {
      lastReplyText = ""
      await session.prompt(text)
      return lastReplyText
    },
    lastReply(): string | undefined {
      return lastReplyText || undefined
    },
  }
}
