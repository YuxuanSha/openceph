import type { OpenCephConfig } from "../config/config-schema.js";
import type { InboundMessage } from "./adapters/channel-plugin.js";
/**
 * Resolves session keys from inbound messages.
 * DM (dmScope = "main"): all channels share "agent:ceph:main"
 * DM (dmScope = "per-channel-peer"): "agent:ceph:{channel}:dm:{senderId}"
 */
export declare class SessionResolver {
    private config;
    constructor(config: OpenCephConfig);
    resolve(msg: InboundMessage): string;
}
