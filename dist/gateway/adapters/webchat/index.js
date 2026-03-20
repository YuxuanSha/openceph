import { createWebChatServer } from "./server.js";
import { gatewayLogger } from "../../../logger/index.js";
export class WebChatChannelPlugin {
    channelId = "webchat";
    displayName = "WebChat";
    defaultDmPolicy = "open";
    server = null;
    wss = null;
    sendToClient = null;
    messageHandler = null;
    port = 18791;
    authToken;
    async initialize(config, _auth) {
        this.port = config.port ?? 18791;
        this.authToken = config.auth?.token;
    }
    async start() {
        const result = createWebChatServer({
            port: this.port,
            authToken: this.authToken,
            onMessage: async (msg) => {
                await this.messageHandler?.(msg);
            },
        });
        this.server = result.server;
        this.wss = result.wss;
        this.sendToClient = result.sendToClient;
        return new Promise((resolve, reject) => {
            const server = this.server;
            const wss = this.wss;
            const cleanup = () => {
                server.off("error", onError);
                server.off("listening", onListening);
                wss?.off("error", onError);
            };
            const onListening = () => {
                cleanup();
                gatewayLogger.info("channel_start", { channel: "webchat", port: this.port });
                resolve();
            };
            const onError = (error) => {
                cleanup();
                server.close();
                if (error.code === "EADDRINUSE") {
                    reject(new Error(`WebChat port ${this.port} is already in use`));
                    return;
                }
                reject(error);
            };
            server.once("error", onError);
            wss?.once("error", onError);
            server.once("listening", onListening);
            server.listen(this.port, "127.0.0.1");
        });
    }
    async stop() {
        this.wss?.close();
        this.server?.close();
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    async send(target, content) {
        this.sendToClient?.(target.senderId, {
            type: "message_complete",
            text: content.text,
        });
    }
    validateSender(_senderId, policy, _allowFrom) {
        return policy !== "disabled";
    }
}
