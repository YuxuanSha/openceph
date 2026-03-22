import { type AgentSession } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { PiContext } from "./pi-context.js";
import type { OpenCephConfig } from "../config/config-schema.js";
export interface BrainSessionOptions {
    sessionFilePath: string;
    modelId?: string;
    systemPrompt?: string;
    customTools?: import("@mariozechner/pi-coding-agent").ToolDefinition<any, any>[];
    thinkingLevel?: ThinkingLevel;
}
export interface BrainSession {
    session: AgentSession;
    prompt(text: string): Promise<string>;
    lastReply(): string | undefined;
}
export declare function createBrainSession(piCtx: PiContext, config: OpenCephConfig, options: BrainSessionOptions): Promise<BrainSession>;
