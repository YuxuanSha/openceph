import type { ChannelPlugin, MessageTarget, OutboundContent } from "./adapters/channel-plugin.js";
import type { Brain } from "../brain/brain.js";
import type { OpenCephConfig } from "../config/config-schema.js";
import { PairingManager } from "./pairing.js";
export declare class Gateway {
    private channelPlugins;
    private router;
    private messageQueue;
    private sessionResolver;
    private pairingManager;
    private authProfileManager;
    private brain;
    private config;
    private pluginLoader;
    private pluginOpsPath;
    private pluginStatePath;
    private pluginOpsWatcher;
    constructor(config: OpenCephConfig, brain: Brain);
    start(): Promise<void>;
    stop(): Promise<void>;
    registerChannel(plugin: ChannelPlugin): void;
    deliverToUser(target: MessageTarget, content: OutboundContent): Promise<void>;
    get pairing(): PairingManager;
    private watchPluginOps;
    private handlePluginOperation;
    private startPlugin;
    private writePluginState;
}
