import type { ChannelPlugin, ChannelConfig, DmPolicy, MessageTarget, OutboundContent, InboundMessage, AuthSystem, StreamingHandle, TypingHandle } from "../channel-plugin.js";
export declare class FeishuChannelPlugin implements ChannelPlugin {
    readonly channelId = "feishu";
    readonly displayName = "\u98DE\u4E66 (Feishu)";
    readonly defaultDmPolicy: DmPolicy;
    private client;
    private directClient;
    private wsClient;
    private config;
    private messageHandler;
    /** Dedup: track recently seen message_ids to prevent Feishu SDK retry redelivery */
    private seenMessageIds;
    private dedupCleanupTimer;
    private startupMonitor;
    private sdkLogger;
    private startedAt;
    initialize(config: ChannelConfig, _auth: AuthSystem): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    private createStartupMonitor;
    private createSdkLogger;
    private parseSdkLog;
    private flattenSdkArgs;
    private resolveStartup;
    private rejectStartup;
    onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
    send(target: MessageTarget, content: OutboundContent): Promise<void>;
    beginTyping(msg: InboundMessage): Promise<TypingHandle>;
    beginStreaming(target: MessageTarget): Promise<StreamingHandle>;
    validateSender(senderId: string, policy: DmPolicy, allowFrom: string[]): boolean;
    private resolveSendTarget;
    private sendReplyOrDirect;
    private sendReplyOrDirectWithClient;
    private sendDirectWithClient;
}
