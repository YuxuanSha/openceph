import * as readline from "readline";
export class CliChannelPlugin {
    channelId = "cli";
    displayName = "CLI Terminal";
    defaultDmPolicy = "open";
    rl = null;
    messageHandler = null;
    running = false;
    async initialize(_config, _auth) {
        // CLI needs no special initialization
    }
    async start() {
        this.running = true;
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        console.log("🐙 Ceph ready. Type /help for commands.");
        const promptUser = () => {
            if (!this.running)
                return;
            this.rl?.question("> ", async (text) => {
                if (!text?.trim()) {
                    promptUser();
                    return;
                }
                if (text.trim() === "/exit" || text.trim() === "/quit") {
                    this.running = false;
                    this.rl?.close();
                    process.exit(0);
                }
                const msg = {
                    channel: "cli",
                    senderId: "cli:local",
                    sessionKey: "",
                    text: text.trim(),
                    timestamp: Date.now(),
                    rawPayload: {},
                };
                await this.messageHandler?.(msg);
                promptUser();
            });
        };
        promptUser();
    }
    async stop() {
        this.running = false;
        this.rl?.close();
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    async send(_target, content) {
        console.log(content.text);
        console.log();
    }
    validateSender(_senderId, _policy, _allowFrom) {
        return true; // CLI is always allowed
    }
}
