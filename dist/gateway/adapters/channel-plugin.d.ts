export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export interface ChannelConfig {
    enabled: boolean;
    dmPolicy: DmPolicy;
    allowFrom: string[];
    streaming: boolean;
    [key: string]: unknown;
}
export interface MessageTarget {
    channel: string;
    senderId: string;
    recipientId?: string;
    replyToId?: string;
    threadId?: string;
    chatId?: string;
    metadata?: Record<string, unknown>;
}
export interface OutboundContent {
    text: string;
    timing: "immediate" | "best_time" | "morning_digest";
    priority: "urgent" | "normal" | "low";
    messageId: string;
}
export interface InboundMessage {
    channel: string;
    senderId: string;
    sessionKey: string;
    text?: string;
    mediaUrls?: string[];
    replyToId?: string;
    timestamp: number;
    rawPayload: Record<string, unknown>;
}
export interface TypingHandle {
    stop(): Promise<void>;
}
export interface PairingEntry {
    code: string;
    senderId: string;
    channel: string;
    status: "pending" | "approved" | "rejected" | "expired";
    createdAt: string;
    expiresAt: string;
}
export interface AuthSystem {
}
/**
 * Handle returned by beginStreaming() to push deltas and finalize.
 */
export interface StreamingHandle {
    /** Called with the full accumulated text so far (throttled by adapter). */
    update(accumulated: string): Promise<void>;
    /** Called once when streaming is fully complete with the final text. */
    finalize(text: string): Promise<void>;
}
export interface ChannelPlugin {
    readonly channelId: string;
    readonly displayName: string;
    readonly defaultDmPolicy: DmPolicy;
    initialize(config: ChannelConfig, auth: AuthSystem): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
    send(target: MessageTarget, content: OutboundContent): Promise<void>;
    validateSender(senderId: string, policy: DmPolicy, allowFrom: string[]): boolean;
    beginTyping?(msg: InboundMessage): Promise<TypingHandle>;
    /**
     * Optional: begin a streaming response. Returns a handle to push deltas.
     * If not implemented, router falls back to send() with the final text.
     */
    beginStreaming?(target: MessageTarget): Promise<StreamingHandle>;
    pairing?: {
        requestCode(senderId: string): Promise<string>;
        approve(code: string): Promise<boolean>;
        reject(code: string): Promise<boolean>;
        list(): Promise<PairingEntry[]>;
    };
}
