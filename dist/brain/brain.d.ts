import type { PiContext } from "../pi/pi-context.js";
import type { OpenCephConfig } from "../config/config-schema.js";
import { type GatewayDeliveryFn } from "../tools/user-tools.js";
import { TentacleManager } from "../tentacle/manager.js";
export interface BrainOptions {
    config: OpenCephConfig;
    piCtx: PiContext;
    deliverToUser?: GatewayDeliveryFn;
}
export interface BrainInput {
    text: string;
    channel: string;
    senderId: string;
    sessionKey: string;
    isDm: boolean;
    onTextDelta?: (delta: string) => void;
}
export interface ToolCallRecord {
    name: string;
    success: boolean;
    durationMs?: number;
}
export interface BrainOutput {
    text: string;
    errorMessage?: string;
    toolCalls: ToolCallRecord[];
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    model: string;
    durationMs: number;
}
export interface SessionStatusInfo {
    sessionKey: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    activeTentacles: number;
    todayCostUsd: number;
}
export declare class Brain {
    private session;
    private toolRegistry;
    private sessionStore;
    private config;
    private piCtx;
    private currentSessionKey;
    private currentModel;
    private lastActiveChannel;
    private lastActiveSenderId;
    private totalInputTokens;
    private totalOutputTokens;
    private ipcServer;
    private tentacleRegistry;
    private pendingReports;
    private tentacleManager;
    private skillLoader;
    private skillSpawner;
    constructor(options: BrainOptions);
    initialize(): Promise<void>;
    /** Write TOOLS.md to workspace dir based on actually registered tools */
    private syncToolsMd;
    /** Register additional tools (e.g. MCP tools discovered after Brain construction) */
    registerTools(entries: import("../tools/index.js").ToolRegistryEntry[]): Promise<void>;
    handleMessage(input: BrainInput): Promise<BrainOutput>;
    getSessionStatus(): SessionStatusInfo;
    resetSession(newModel?: string, sessionKey?: string): Promise<void>;
    shutdown(): Promise<void>;
    get model(): string;
    listTentacles(): ReturnType<TentacleManager["listAll"]>;
    private loadSkillsSummary;
}
