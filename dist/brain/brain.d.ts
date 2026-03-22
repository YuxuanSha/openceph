import type { PiContext } from "../pi/pi-context.js";
import type { OpenCephConfig } from "../config/config-schema.js";
import { type GatewayDeliveryFn } from "../tools/user-tools.js";
import { TentacleManager } from "../tentacle/manager.js";
import type { CronScheduler } from "../cron/cron-scheduler.js";
import type { HeartbeatScheduler } from "../heartbeat/scheduler.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { OutboundQueue } from "../push/outbound-queue.js";
import { PushDecisionEngine, type PushTrigger } from "../push/push-decision.js";
import { PushFeedbackTracker } from "../push/feedback-tracker.js";
import { TentacleHealthCalculator } from "../tentacle/health-score.js";
import { TentacleReviewEngine } from "../tentacle/review-engine.js";
import { type FailoverDecision } from "./failover.js";
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
    thinkingLevelOverride?: ThinkingLevel;
    reasoningEnabledOverride?: boolean;
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
    private cronScheduler;
    private heartbeatScheduler;
    private currentThinkingLevel;
    private reasoningEnabled;
    private turnsSinceHeartbeat;
    private outboundQueue;
    private pushEngine;
    private feedbackTracker;
    private healthCalculator;
    private lifecycleManager;
    private reviewEngine;
    private modelFailover;
    private recentPushContext;
    private readonly deliverToUser?;
    private readonly memoryManager;
    private readonly consultationStore;
    private readonly pushMessageToConsultationSession;
    constructor(options: BrainOptions);
    initialize(): Promise<void>;
    /** Write TOOLS.md to workspace dir based on actually registered tools */
    private syncToolsMd;
    /** Register additional tools (e.g. MCP tools discovered after Brain construction) */
    registerTools(entries: import("../tools/index.js").ToolRegistryEntry[]): Promise<void>;
    handleMessage(input: BrainInput): Promise<BrainOutput>;
    runHeartbeatTurn(text: string): Promise<BrainOutput>;
    runIsolatedTurn(params: {
        sessionKey: string;
        message: string;
        model?: string;
        mode?: "full" | "minimal";
        thinking?: string;
    }): Promise<BrainOutput>;
    registerCronScheduler(cronScheduler: CronScheduler): Promise<void>;
    registerHeartbeatScheduler(heartbeatScheduler: HeartbeatScheduler): void;
    private executeTurn;
    getSessionStatus(): SessionStatusInfo;
    resetSession(newModel?: string, sessionKey?: string): Promise<void>;
    shutdown(): Promise<void>;
    get model(): string;
    get thinkingLevel(): ThinkingLevel;
    get reasoningMode(): boolean;
    listTentacles(): ReturnType<TentacleManager["listAll"]>;
    listSkills(): Promise<string[]>;
    listToolNames(): string[];
    getLastActiveTarget(channel?: string): {
        channel: string;
        senderId: string;
        recipientId?: string;
    } | null;
    triggerTentacleCron(tentacleId: string, jobId: string): Promise<boolean>;
    triggerTentacleHeartbeat(tentacleId: string, prompt: string, jobId: string): Promise<boolean>;
    getTentacleManager(): TentacleManager;
    getPendingReportCount(): Promise<number>;
    getOutboundQueue(): OutboundQueue;
    getPushEngine(): PushDecisionEngine;
    getFeedbackTracker(): PushFeedbackTracker;
    getHealthCalculator(): TentacleHealthCalculator;
    getReviewEngine(): TentacleReviewEngine | null;
    /**
     * Evaluate push decision for non-user-message triggers (heartbeat, daily-review, urgent).
     */
    evaluatePush(trigger: PushTrigger): Promise<string | null>;
    runDailyReviewAutomation(): Promise<string>;
    runMorningDigestFallback(): Promise<string>;
    setThinkingLevel(level: string): ThinkingLevel;
    setReasoningEnabled(enabled: boolean): void;
    compactSession(customInstructions?: string): Promise<string>;
    /**
     * Check context pressure and potentially switch to fallback model.
     * Called periodically or after heavy turns.
     */
    checkAndFailover(): FailoverDecision;
    private writeRuntimeStatus;
    runCronJob(jobId: string): Promise<void>;
    getCronJob(jobId: string): import("../cron/cron-types.js").CronJob | undefined;
    private handleTentacleConsultation;
    private queueConsultationItems;
    private rememberDeliveredPush;
    private recordFeedbackForRecentPush;
    private processConsultationUserReply;
    private upsertConsultationSession;
    private deliverPushNow;
    private loadSkillsSummary;
    private buildSystemPrompt;
}
