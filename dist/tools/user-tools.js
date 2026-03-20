import { Type } from "@sinclair/typebox";
import { brainLogger } from "../logger/index.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
function ok(text) {
    return { content: [{ type: "text", text }], details: undefined };
}
export function createUserTools(opts) {
    const sendToUser = {
        name: "send_to_user",
        label: "Send to User",
        description: "向用户发送主动消息。仅用于异步通知/主动外呼，不用于当前对话轮的直接回复。",
        promptSnippet: "send_to_user — 仅用于异步通知或主动外呼；正常对话直接回复文本，不要调用此工具",
        parameters: Type.Object({
            message: Type.String({ description: "发送给用户的完整消息内容" }),
            timing: Type.Union([
                Type.Literal("immediate"),
                Type.Literal("best_time"),
                Type.Literal("morning_digest"),
            ]),
            channel: Type.Optional(Type.Union([
                Type.Literal("telegram"),
                Type.Literal("feishu"),
                Type.Literal("webchat"),
                Type.Literal("last_active"),
            ])),
            priority: Type.Optional(Type.Union([
                Type.Literal("urgent"),
                Type.Literal("normal"),
                Type.Literal("low"),
            ])),
        }),
        async execute(_id, params) {
            const channel = params.channel === "last_active" || !params.channel
                ? (opts.lastActiveChannel?.() ?? "cli")
                : params.channel;
            const senderId = opts.lastActiveSenderId?.() ?? "local";
            const priority = params.priority ?? "normal";
            const messageId = crypto.randomUUID();
            if (params.timing === "immediate" && opts.deliverToUser) {
                try {
                    await opts.deliverToUser({ channel, senderId }, { text: params.message, timing: "immediate", priority, messageId });
                    brainLogger.info("send_to_user", {
                        channel, timing: "immediate", priority, message_id: messageId,
                    });
                    return ok(JSON.stringify({ success: true, channel, timing: "immediate" }));
                }
                catch (err) {
                    brainLogger.error("send_to_user_failed", { error: err.message });
                    return ok(`Error delivering message: ${err.message}`);
                }
            }
            // Non-immediate: queue for later processing
            const queuePath = path.join(os.homedir(), ".openceph", "state", "outbound-queue.json");
            try {
                await fs.mkdir(path.dirname(queuePath), { recursive: true });
                let queue = [];
                try {
                    queue = JSON.parse(await fs.readFile(queuePath, "utf-8"));
                }
                catch { /* empty queue */ }
                queue.push({
                    messageId,
                    message: params.message,
                    timing: params.timing,
                    channel,
                    senderId,
                    priority,
                    createdAt: new Date().toISOString(),
                });
                await fs.writeFile(queuePath, JSON.stringify(queue, null, 2), "utf-8");
                brainLogger.info("send_to_user_queued", {
                    channel, timing: params.timing, priority, message_id: messageId,
                });
                return ok(JSON.stringify({ success: true, channel, timing: params.timing, queued: true }));
            }
            catch (err) {
                return ok(`Error queuing message: ${err.message}`);
            }
        },
    };
    return [
        { name: "send_to_user", description: sendToUser.description, group: "messaging", tool: sendToUser },
    ];
}
