import type { ChannelPlugin, ChannelConfig, DmPolicy, MessageTarget, OutboundContent, InboundMessage, AuthSystem } from "../channel-plugin.js";
export declare class WebChatChannelPlugin implements ChannelPlugin {
    readonly channelId = "webchat";
    readonly displayName = "WebChat";
    readonly defaultDmPolicy: DmPolicy;
    private server;
    private wss;
    private sendToClient;
    private messageHandler;
    private port;
    private authToken?;
    initialize(config: ChannelConfig, _auth: AuthSystem): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
    send(target: MessageTarget, content: OutboundContent): Promise<void>;
    validateSender(_senderId: string, policy: DmPolicy, _allowFrom: string[]): boolean;
}
