import { WebSocketServer } from "ws";
import * as http from "http";
import type { InboundMessage } from "../channel-plugin.js";
export declare function createWebChatServer(opts: {
    port: number;
    authToken?: string;
    onMessage: (msg: InboundMessage) => Promise<void>;
    onTextDelta?: (senderId: string, delta: string) => void;
}): {
    server: http.Server;
    wss: WebSocketServer;
    sendToClient: (senderId: string, data: any) => void;
};
