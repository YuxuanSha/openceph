import type { MessageTarget, OutboundContent } from "../gateway/adapters/channel-plugin.js";
import type { ToolRegistryEntry } from "./index.js";
export interface GatewayDeliveryFn {
    (target: MessageTarget, content: OutboundContent): Promise<void>;
}
export declare function createUserTools(opts: {
    deliverToUser?: GatewayDeliveryFn;
    lastActiveChannel?: () => string;
    lastActiveSenderId?: () => string;
}): ToolRegistryEntry[];
