import type { ChannelPlugin, ChannelConfig, DmPolicy, MessageTarget, OutboundContent, InboundMessage, AuthSystem } from "../channel-plugin.js";
export declare class CliChannelPlugin implements ChannelPlugin {
    readonly channelId = "cli";
    readonly displayName = "CLI Terminal";
    readonly defaultDmPolicy: DmPolicy;
    private rl;
    private messageHandler;
    private running;
    initialize(_config: ChannelConfig, _auth: AuthSystem): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
    send(_target: MessageTarget, content: OutboundContent): Promise<void>;
    validateSender(_senderId: string, _policy: DmPolicy, _allowFrom: string[]): boolean;
}
