import type { MessageTarget, OutboundContent } from "../gateway/adapters/channel-plugin.js";
import type { ToolRegistryEntry } from "./index.js";
import type { SessionStoreManager } from "../session/session-store.js";
import type { OpenCephConfig } from "../config/config-schema.js";
export interface GatewayDeliveryFn {
    (target: MessageTarget, content: OutboundContent): Promise<void>;
}
export interface SendToUserToolParams {
    message: string;
    timing: "immediate" | "best_time" | "morning_digest";
    channel?: "telegram" | "feishu" | "webchat" | "last_active";
    priority?: "urgent" | "normal" | "low";
    source_tentacles?: string[];
}
export interface SendToUserRuntimeOptions {
    currentSessionKey: string;
    mainSessionKey: string;
    deliverToUser?: GatewayDeliveryFn;
    lastActiveChannel: () => string;
    lastActiveSenderId: () => string;
    sessionStore?: SessionStoreManager;
    queuePath?: string;
    onConsultationPush?: (payload: {
        pushId: string;
        sessionKey: string;
        targetSessionKey: string;
        channel: string;
        senderId: string;
        timing: SendToUserToolParams["timing"];
        priority: NonNullable<SendToUserToolParams["priority"]>;
        message: string;
        tentacleId?: string;
        delivered: boolean;
    }) => Promise<void> | void;
}
export declare function executeSendToUser(params: SendToUserToolParams, runtime: SendToUserRuntimeOptions): Promise<{
    content: {
        type: "text";
        text: string;
    }[];
    details: Record<string, unknown> | undefined;
}>;
export declare function createUserTools(opts: {
    config?: OpenCephConfig;
    sessionStore?: SessionStoreManager;
    deliverToUser?: GatewayDeliveryFn;
    lastActiveChannel?: () => string;
    lastActiveSenderId?: () => string;
    queuePath?: string;
    resolveSessionKey?: (sessionFile: string) => Promise<string | undefined>;
    onConsultationPush?: SendToUserRuntimeOptions["onConsultationPush"];
}): ToolRegistryEntry[];
