import type { ChannelPlugin, InboundMessage } from "./adapters/channel-plugin.js";
import type { Brain } from "../brain/brain.js";
import type { OpenCephConfig } from "../config/config-schema.js";
import { PairingManager } from "./pairing.js";
import { SessionResolver } from "./session-manager.js";
import { MessageQueue } from "./message-queue.js";
export declare class ChannelRouter {
    private channels;
    private pairingManager;
    private sessionResolver;
    private messageQueue;
    private brain;
    private config;
    private commandHandler;
    constructor(channels: Map<string, ChannelPlugin>, pairingManager: PairingManager, sessionResolver: SessionResolver, messageQueue: MessageQueue, brain: Brain, config: OpenCephConfig);
    private registerCommands;
    route(msg: InboundMessage): Promise<void>;
    private getChannelConfig;
    private buildReplyTarget;
}
