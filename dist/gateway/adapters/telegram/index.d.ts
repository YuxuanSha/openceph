import type { ChannelPlugin, ChannelConfig, DmPolicy, MessageTarget, OutboundContent, InboundMessage, AuthSystem, StreamingHandle } from "../channel-plugin.js";
export declare class TelegramChannelPlugin implements ChannelPlugin {
    readonly channelId = "telegram";
    readonly displayName = "Telegram";
    readonly defaultDmPolicy: DmPolicy;
    private bot;
    private messageHandler;
    private config;
    initialize(config: ChannelConfig, _auth: AuthSystem): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
    send(target: MessageTarget, content: OutboundContent): Promise<void>;
    beginStreaming(target: MessageTarget): Promise<StreamingHandle>;
    validateSender(senderId: string, policy: DmPolicy, allowFrom: string[]): boolean;
}
