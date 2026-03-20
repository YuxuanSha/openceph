import { Bot } from "grammy";
import { chunkMessage } from "./formatter.js";
import { gatewayLogger } from "../../../logger/index.js";
const STREAM_THROTTLE_MS = 500; // min ms between Telegram edit calls
const STREAM_PLACEHOLDER = "💭 思考中...";
export class TelegramChannelPlugin {
    channelId = "telegram";
    displayName = "Telegram";
    defaultDmPolicy = "pairing";
    bot = null;
    messageHandler = null;
    config = null;
    async initialize(config, _auth) {
        this.config = config;
        const botToken = config.botToken;
        if (!botToken) {
            throw new Error("Telegram botToken not configured");
        }
        this.bot = new Bot(botToken);
        this.bot.on("message:text", async (ctx) => {
            const msg = {
                channel: "telegram",
                senderId: `tg:${ctx.from.id}`,
                sessionKey: "",
                text: ctx.message.text,
                timestamp: ctx.message.date * 1000,
                rawPayload: ctx.message,
            };
            await this.messageHandler?.(msg);
        });
    }
    async start() {
        if (!this.bot)
            throw new Error("Telegram bot not initialized");
        // Start long polling (non-blocking)
        this.bot.start({
            onStart: () => {
                gatewayLogger.info("channel_start", { channel: "telegram" });
            },
        });
    }
    async stop() {
        await this.bot?.stop();
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    async send(target, content) {
        if (!this.bot)
            return;
        const chatId = target.senderId.replace("tg:", "");
        const chunks = chunkMessage(content.text, this.config?.textChunkLimit ?? 4000);
        for (const chunk of chunks) {
            try {
                // Send as plain text (MarkdownV2 escaping is complex, use plain for reliability)
                await this.bot.api.sendMessage(chatId, chunk);
            }
            catch (err) {
                gatewayLogger.error("telegram_send_error", { error: err.message, chat_id: chatId });
            }
        }
    }
    async beginStreaming(target) {
        if (!this.bot)
            throw new Error("Telegram bot not initialized");
        const bot = this.bot; // capture for closure
        const chatId = target.senderId.replace("tg:", "");
        // Send typing indicator and placeholder message
        await bot.api.sendChatAction(chatId, "typing").catch(() => { });
        let sentMessageId = null;
        try {
            const sent = await this.bot.api.sendMessage(chatId, STREAM_PLACEHOLDER);
            sentMessageId = sent.message_id;
        }
        catch (err) {
            gatewayLogger.error("telegram_stream_init_error", { error: err.message });
        }
        let lastUpdate = 0;
        let pendingText = "";
        let updateTimer = null;
        const doEdit = async (text) => {
            if (!sentMessageId)
                return;
            const truncated = text.slice(0, 4096);
            try {
                await bot.api.editMessageText(chatId, sentMessageId, truncated);
                lastUpdate = Date.now();
            }
            catch (err) {
                // Ignore "message not modified" (same content)
                if (!err.message?.includes("not modified")) {
                    gatewayLogger.warn("telegram_edit_error", { error: err.message });
                }
            }
        };
        return {
            async update(accumulated) {
                pendingText = accumulated;
                const elapsed = Date.now() - lastUpdate;
                if (elapsed >= STREAM_THROTTLE_MS) {
                    if (updateTimer) {
                        clearTimeout(updateTimer);
                        updateTimer = null;
                    }
                    await doEdit(accumulated);
                }
                else if (!updateTimer) {
                    updateTimer = setTimeout(async () => {
                        updateTimer = null;
                        await doEdit(pendingText);
                    }, STREAM_THROTTLE_MS - elapsed);
                }
            },
            async finalize(text) {
                if (updateTimer) {
                    clearTimeout(updateTimer);
                    updateTimer = null;
                }
                if (!text)
                    return;
                if (sentMessageId) {
                    // Final edit with complete text
                    const chunks = chunkMessage(text, 4096);
                    await doEdit(chunks[0]);
                    // Send overflow chunks as new messages
                    for (let i = 1; i < chunks.length; i++) {
                        try {
                            await bot.api.sendMessage(chatId, chunks[i]);
                        }
                        catch (err) {
                            gatewayLogger.error("telegram_overflow_error", { error: err.message });
                        }
                    }
                }
                else {
                    // Fallback: no streaming message, send normally
                    const chunks = chunkMessage(text, 4096);
                    for (const chunk of chunks) {
                        await bot.api.sendMessage(chatId, chunk).catch((err) => {
                            gatewayLogger.error("telegram_fallback_send_error", { error: err.message });
                        });
                    }
                }
            },
        };
    }
    validateSender(senderId, policy, allowFrom) {
        if (policy === "open")
            return true;
        if (policy === "disabled")
            return false;
        if (policy === "allowlist")
            return allowFrom.includes(senderId);
        return false; // pairing handled by router
    }
}
