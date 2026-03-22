import { extractText, formatAsFeishuText, feishuCardContent } from "./formatter.js";
import { gatewayLogger } from "../../../logger/index.js";
const FEISHU_STREAM_THROTTLE_MS = 2000;
const FEISHU_STREAM_PLACEHOLDER = "💭 思考中...";
const FEISHU_START_TIMEOUT_MS = 2000;
const FEISHU_MESSAGE_ID_TTL_MS = 24 * 60 * 60 * 1000;
const FEISHU_STALE_MESSAGE_GRACE_MS = 15_000;
const FEISHU_WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003]);
const FEISHU_BACKOFF_CODES = new Set([99991400, 99991403, 429]);
export class FeishuChannelPlugin {
    channelId = "feishu";
    displayName = "飞书 (Feishu)";
    defaultDmPolicy = "pairing";
    client = null;
    directClient = null;
    wsClient = null;
    config = null;
    messageHandler = null;
    /** Dedup: track recently seen message_ids to prevent Feishu SDK retry redelivery */
    seenMessageIds = new Map();
    dedupCleanupTimer = null;
    startupMonitor = null;
    sdkLogger = null;
    startedAt = 0;
    async initialize(config, _auth) {
        this.config = config;
        const appId = config.appId;
        const appSecret = config.appSecret;
        const proxyMode = config.proxyMode ?? "direct";
        if (!appId || !appSecret) {
            throw new Error("Feishu appId and appSecret required");
        }
        const lark = await import("@larksuiteoapi/node-sdk");
        const axios = await import("axios");
        const domain = config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
        const logger = this.createSdkLogger();
        this.sdkLogger = logger;
        const createHttpInstance = (mode) => {
            const httpInstanceConfig = {};
            if (mode === "direct") {
                httpInstanceConfig.proxy = false;
            }
            const httpInstance = axios.default.create(httpInstanceConfig);
            httpInstance.interceptors.request.use((req) => {
                if (req.headers) {
                    req.headers["User-Agent"] = "oapi-node-sdk/1.0.0";
                }
                return req;
            }, undefined, { synchronous: true });
            httpInstance.interceptors.response.use((resp) => {
                if (resp.config?.["$return_headers"]) {
                    return { data: resp.data, headers: resp.headers };
                }
                return resp.data;
            });
            return httpInstance;
        };
        const createClient = (mode) => new lark.Client({
            appId,
            appSecret,
            domain,
            httpInstance: createHttpInstance(mode),
            logger,
            loggerLevel: lark.LoggerLevel.info,
        });
        this.client = createClient(proxyMode === "direct" ? "direct" : "inherit");
        this.directClient = proxyMode === "direct" ? this.client : createClient("direct");
        // Pass a proxy agent to WSClient so the WS connection uses the system proxy.
        // The ws package doesn't auto-read HTTP_PROXY env, so we must inject it manually.
        const proxyUrl = process.env.HTTPS_PROXY ||
            process.env.https_proxy ||
            process.env.HTTP_PROXY ||
            process.env.http_proxy ||
            process.env.ALL_PROXY ||
            process.env.all_proxy;
        let wsAgent = undefined;
        if (proxyUrl && proxyMode !== "direct") {
            const { HttpsProxyAgent } = await import("https-proxy-agent");
            wsAgent = new HttpsProxyAgent(proxyUrl);
            gatewayLogger.info("feishu_ws_proxy", { proxy: proxyUrl });
        }
        else if (proxyMode === "direct") {
            gatewayLogger.info("feishu_proxy_bypass", { mode: proxyMode, channel: "feishu" });
        }
        this.wsClient = new lark.WSClient({
            appId,
            appSecret,
            domain,
            logger,
            loggerLevel: lark.LoggerLevel.info,
            ...(wsAgent ? { agent: wsAgent } : {}),
        });
    }
    async start() {
        if (!this.wsClient)
            throw new Error("Feishu client not initialized");
        this.startedAt = Date.now();
        const lark = await import("@larksuiteoapi/node-sdk");
        const self = this;
        // Periodically clean up expired dedup entries
        this.dedupCleanupTimer = setInterval(() => {
            const now = Date.now();
            for (const [id, ts] of this.seenMessageIds) {
                if (now - ts > FEISHU_MESSAGE_ID_TTL_MS) {
                    this.seenMessageIds.delete(id);
                }
            }
        }, 30_000);
        const eventDispatcher = new lark.EventDispatcher({
            logger: this.sdkLogger ?? this.createSdkLogger(),
            loggerLevel: lark.LoggerLevel.info,
        }).register({
            "im.message.receive_v1": async (data) => {
                const messageId = data.message?.message_id;
                const messageType = data.message?.message_type;
                const senderType = data.sender?.sender_type ??
                    data.sender?.sender_id?.sender_type ??
                    data.message?.sender?.sender_type;
                const messageTimestamp = parseInt(data.message?.create_time ?? "0") * 1000;
                // Ignore messages sent by the bot/app itself to avoid echo loops.
                if (senderType === "app") {
                    gatewayLogger.info("feishu_self_message_ignored", {
                        message_id: messageId,
                        message_type: messageType,
                    });
                    return;
                }
                // M1 only supports plain text DM input.
                if (messageType && messageType !== "text") {
                    gatewayLogger.info("feishu_non_text_ignored", {
                        message_id: messageId,
                        message_type: messageType,
                    });
                    return;
                }
                // Ignore old events replayed after reconnect/startup.
                if (messageTimestamp > 0 && messageTimestamp < self.startedAt - FEISHU_STALE_MESSAGE_GRACE_MS) {
                    gatewayLogger.info("feishu_stale_message_ignored", {
                        message_id: messageId,
                        message_type: messageType,
                        create_time: messageTimestamp,
                        started_at: self.startedAt,
                    });
                    return;
                }
                // Dedup: skip if we've already seen this message_id (Feishu SDK retry)
                if (messageId) {
                    if (self.seenMessageIds.has(messageId)) {
                        gatewayLogger.info("feishu_duplicate_skipped", { message_id: messageId });
                        return;
                    }
                    self.seenMessageIds.set(messageId, Date.now());
                }
                const text = extractText(data.message).trim();
                if (!text) {
                    gatewayLogger.info("feishu_empty_message_ignored", {
                        message_id: messageId,
                        message_type: messageType,
                    });
                    return;
                }
                const msg = {
                    channel: "feishu",
                    senderId: `feishu:${data.sender?.sender_id?.open_id ?? "unknown"}`,
                    sessionKey: "",
                    text,
                    replyToId: messageId,
                    timestamp: messageTimestamp,
                    rawPayload: data,
                };
                // CRITICAL: Fire-and-forget. Do NOT await the handler.
                // The Feishu WS server will re-send the event if we don't return quickly,
                // because brain processing takes 3-30+ seconds. Returning immediately
                // lets the SDK ack the event to prevent re-delivery.
                void self.messageHandler?.(msg).catch((err) => {
                    gatewayLogger.error("feishu_handler_error", {
                        message_id: messageId,
                        error: err.message,
                    });
                });
            },
        });
        const startup = this.createStartupMonitor();
        this.startupMonitor = startup;
        await this.wsClient.start({ eventDispatcher });
        try {
            await Promise.race([
                startup.promise,
                new Promise((resolve) => setTimeout(resolve, FEISHU_START_TIMEOUT_MS)),
            ]);
        }
        finally {
            this.startupMonitor = null;
        }
        // Validate that the SDK can obtain a tenant_access_token by making a
        // lightweight API call. This surfaces auth/network problems at startup
        // rather than silently failing on the first user message.
        try {
            await this.client.auth.tenantAccessToken.internal({
                data: { app_id: this.config?.appId, app_secret: this.config?.appSecret },
            });
            gatewayLogger.info("feishu_token_ok", { channel: "feishu" });
        }
        catch (err) {
            gatewayLogger.error("feishu_token_prefetch_failed", {
                channel: "feishu",
                error: err.message,
                hint: "Check app credentials, network, and proxy settings. API calls will fail until this is resolved.",
            });
        }
    }
    async stop() {
        if (this.dedupCleanupTimer) {
            clearInterval(this.dedupCleanupTimer);
            this.dedupCleanupTimer = null;
        }
        this.seenMessageIds.clear();
        // Feishu SDK doesn't expose a clean stop method
        this.wsClient = null;
    }
    createStartupMonitor() {
        let resolve = () => { };
        let reject = () => { };
        const promise = new Promise((innerResolve, innerReject) => {
            resolve = innerResolve;
            reject = innerReject;
        });
        return {
            settled: false,
            promise,
            resolve,
            reject,
        };
    }
    createSdkLogger() {
        const forward = (level, ...args) => {
            const entry = this.parseSdkLog(args);
            const meta = entry.meta ? { ...entry.meta } : {};
            if (entry.kind === "ready") {
                gatewayLogger.info("feishu_ws_ready", meta);
                this.resolveStartup();
                return;
            }
            if (entry.kind === "error") {
                gatewayLogger.error("feishu_sdk_error", {
                    message: entry.message,
                    ...meta,
                });
                return;
            }
            if (entry.kind === "warn") {
                gatewayLogger.warn("feishu_sdk_warn", {
                    message: entry.message,
                    ...meta,
                });
                return;
            }
            if (level === "debug" || level === "trace") {
                gatewayLogger.debug("feishu_sdk_debug", {
                    message: entry.message,
                    ...meta,
                });
            }
        };
        return {
            error: (...args) => forward("error", ...args),
            warn: (...args) => forward("warn", ...args),
            info: (...args) => forward("info", ...args),
            debug: (...args) => forward("debug", ...args),
            trace: (...args) => forward("trace", ...args),
        };
    }
    parseSdkLog(args) {
        const values = this.flattenSdkArgs(args);
        const text = values
            .filter((value) => typeof value === "string" && value.length > 0)
            .join(" | ");
        if (text.includes("ws client ready")) {
            return { kind: "ready", message: "Feishu websocket connected", meta: { channel: "feishu" } };
        }
        const httpError = values.find((value) => typeof value === "object" &&
            value !== null &&
            ("response" in value || "config" in value || "request" in value || "message" in value));
        const status = httpError?.response?.status;
        const url = httpError?.config?.url ?? httpError?.request?.path;
        const proxy = process.env.HTTPS_PROXY ||
            process.env.https_proxy ||
            process.env.HTTP_PROXY ||
            process.env.http_proxy ||
            process.env.ALL_PROXY ||
            process.env.all_proxy;
        if (status === 502) {
            return {
                kind: "error",
                message: proxy
                    ? `Feishu API request failed with HTTP 502 via proxy ${proxy}. Check the proxy or direct access to open.feishu.cn.`
                    : "Feishu API request failed with HTTP 502. Check network access to open.feishu.cn.",
                meta: { channel: "feishu", status, url },
            };
        }
        if (text.includes("connect failed")) {
            return {
                kind: "error",
                message: "Feishu websocket connection failed. Check app credentials, event subscription mode, and proxy/network settings.",
                meta: { channel: "feishu" },
            };
        }
        if (status && status >= 400) {
            return {
                kind: "error",
                message: `Feishu API request failed with HTTP ${status}. Check app credentials and network settings.`,
                meta: { channel: "feishu", status, url },
            };
        }
        if (text.includes("need to start with a eventDispatcher")) {
            return {
                kind: "warn",
                message: "Feishu websocket missing event dispatcher.",
                meta: { channel: "feishu" },
            };
        }
        return {
            kind: "debug",
            message: text || "Feishu SDK emitted an unstructured log entry",
            meta: { channel: "feishu" },
        };
    }
    flattenSdkArgs(values) {
        return values.flatMap((value) => {
            if (Array.isArray(value)) {
                return this.flattenSdkArgs(value);
            }
            return [value];
        });
    }
    resolveStartup() {
        if (!this.startupMonitor || this.startupMonitor.settled)
            return;
        this.startupMonitor.settled = true;
        this.startupMonitor.resolve();
    }
    rejectStartup(error) {
        if (!this.startupMonitor || this.startupMonitor.settled)
            return;
        this.startupMonitor.settled = true;
        this.startupMonitor.reject(error);
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    async send(target, content) {
        if (!this.client)
            return;
        const chunkLimit = this.config?.textChunkLimit ?? 2000;
        const resolvedTarget = this.resolveSendTarget(target);
        let lastError = null;
        for (const chunk of chunkText(content.text, chunkLimit)) {
            try {
                gatewayLogger.info("feishu_send_attempt", {
                    receive_id: resolvedTarget.receiveId,
                    receive_id_type: resolvedTarget.receiveIdType,
                    reply_to_id: target.replyToId,
                });
                const result = await this.sendReplyOrDirect({
                    target,
                    msgType: "text",
                    content: formatAsFeishuText(chunk).content,
                });
                gatewayLogger.info("feishu_send_success", { result });
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                gatewayLogger.error("feishu_send_error", { error: err.message, status: err.response?.status, data: err.response?.data });
                break;
            }
        }
        if (lastError) {
            throw lastError;
        }
    }
    async beginTyping(msg) {
        if (!this.client)
            return { stop: async () => { } };
        if (this.config?.typingIndicator === false)
            return { stop: async () => { } };
        if (!msg.replyToId)
            return { stop: async () => { } };
        const emoji = this.config?.typingEmoji ?? "Typing";
        const keepaliveMs = Math.max(500, Number(this.config?.typingKeepaliveMs ?? 3000));
        const reactionIds = new Set();
        let stopped = false;
        let keepaliveTimer = null;
        const addTypingIndicator = async (phase) => {
            if (reactionIds.size > 0) {
                return;
            }
            try {
                const result = await this.client.im.messageReaction.create({
                    path: { message_id: msg.replyToId },
                    data: {
                        reaction_type: {
                            emoji_type: emoji,
                        },
                    },
                });
                const reactionId = result?.data?.reaction_id;
                if (reactionId)
                    reactionIds.add(reactionId);
                gatewayLogger.info(phase === "start" ? "feishu_typing_start" : "feishu_typing_keepalive", {
                    message_id: msg.replyToId,
                    reaction_id: reactionId,
                    emoji,
                    keepalive_ms: keepaliveMs,
                });
            }
            catch (err) {
                if (isFeishuBackoffError(err)) {
                    if (keepaliveTimer) {
                        clearInterval(keepaliveTimer);
                        keepaliveTimer = null;
                    }
                }
                gatewayLogger.warn(phase === "start" ? "feishu_typing_start_error" : "feishu_typing_keepalive_error", {
                    error: err.message,
                    message_id: msg.replyToId,
                    emoji,
                });
            }
        };
        await addTypingIndicator("start");
        keepaliveTimer = setInterval(() => {
            if (stopped)
                return;
            void addTypingIndicator("keepalive");
        }, keepaliveMs);
        return {
            stop: async () => {
                if (stopped)
                    return;
                stopped = true;
                if (keepaliveTimer) {
                    clearInterval(keepaliveTimer);
                    keepaliveTimer = null;
                }
                for (const reactionId of reactionIds) {
                    try {
                        await this.client.im.messageReaction.delete({
                            path: {
                                message_id: msg.replyToId,
                                reaction_id: reactionId,
                            },
                        });
                        gatewayLogger.info("feishu_typing_stop", {
                            message_id: msg.replyToId,
                            reaction_id: reactionId,
                            emoji,
                        });
                    }
                    catch (err) {
                        gatewayLogger.warn("feishu_typing_stop_error", {
                            error: err.message,
                            message_id: msg.replyToId,
                            reaction_id: reactionId,
                            emoji,
                        });
                    }
                }
            },
        };
    }
    async beginStreaming(target) {
        if (!this.client)
            throw new Error("Feishu client not initialized");
        const resolvedTarget = this.resolveSendTarget(target);
        const sendReplyOrDirect = this.sendReplyOrDirect.bind(this);
        // Send initial placeholder card. Prefer reply semantics so the visible UX
        // stays anchored to the inbound message, but fall back to a direct send if
        // the reply target was withdrawn or is no longer available.
        let streamMsgId = null;
        try {
            const initResult = await this.sendReplyOrDirect({
                target,
                msgType: "interactive",
                content: feishuCardContent(FEISHU_STREAM_PLACEHOLDER),
            });
            streamMsgId = initResult?.data?.message_id ?? null;
            gatewayLogger.info("feishu_stream_init", {
                message_id: streamMsgId,
                receive_id: resolvedTarget.receiveId,
                receive_id_type: resolvedTarget.receiveIdType,
                reply_to_id: target.replyToId,
            });
        }
        catch (err) {
            gatewayLogger.error("feishu_stream_init_error", { error: err.message });
        }
        let lastUpdate = 0;
        let pendingText = "";
        let updateTimer = null;
        let patchInFlight = false;
        const client = this.client;
        const doPatch = async (text) => {
            if (!streamMsgId || patchInFlight)
                return;
            patchInFlight = true;
            try {
                await client.im.message.patch({
                    path: { message_id: streamMsgId },
                    data: {
                        content: feishuCardContent(text),
                    },
                });
                lastUpdate = Date.now();
            }
            catch (err) {
                gatewayLogger.warn("feishu_patch_error", { error: err.message });
            }
            finally {
                patchInFlight = false;
            }
        };
        return {
            async update(accumulated) {
                pendingText = accumulated;
                if (patchInFlight)
                    return; // skip while a patch is in-flight
                const elapsed = Date.now() - lastUpdate;
                if (elapsed >= FEISHU_STREAM_THROTTLE_MS) {
                    if (updateTimer) {
                        clearTimeout(updateTimer);
                        updateTimer = null;
                    }
                    await doPatch(accumulated);
                }
                else if (!updateTimer) {
                    updateTimer = setTimeout(async () => {
                        updateTimer = null;
                        if (!patchInFlight)
                            await doPatch(pendingText);
                    }, FEISHU_STREAM_THROTTLE_MS - elapsed);
                }
            },
            async finalize(text) {
                if (updateTimer) {
                    clearTimeout(updateTimer);
                    updateTimer = null;
                }
                if (!text)
                    return;
                if (streamMsgId) {
                    await doPatch(text);
                }
                else {
                    // Fallback: initial card send failed, send as plain text
                    try {
                        await sendReplyOrDirect({
                            target,
                            msgType: "text",
                            content: JSON.stringify({ text }),
                        });
                    }
                    catch (err) {
                        gatewayLogger.error("feishu_fallback_send_error", { error: err.message });
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
        return false;
    }
    resolveSendTarget(target) {
        const chatId = typeof target.chatId === "string" ? target.chatId.trim() : "";
        if (chatId) {
            return { receiveId: chatId, receiveIdType: "chat_id" };
        }
        const recipientId = typeof target.recipientId === "string" ? target.recipientId : target.senderId;
        return {
            receiveId: recipientId.replace("feishu:", ""),
            receiveIdType: "open_id",
        };
    }
    async sendReplyOrDirect(params) {
        return this.sendReplyOrDirectWithClient(this.client, params, true);
    }
    async sendReplyOrDirectWithClient(client, params, allowDirectFallback) {
        const resolvedTarget = this.resolveSendTarget(params.target);
        const replyToId = params.target.replyToId?.trim();
        if (replyToId) {
            try {
                const response = await client.im.message.reply({
                    path: { message_id: replyToId },
                    data: {
                        content: params.content,
                        msg_type: params.msgType,
                    },
                });
                if (!shouldFallbackFromReplyTarget(response)) {
                    return response;
                }
                gatewayLogger.warn("feishu_reply_fallback", {
                    reply_to_id: replyToId,
                    code: response?.code,
                    msg: response?.msg,
                });
            }
            catch (err) {
                if (allowDirectFallback && this.directClient && client !== this.directClient && isFeishuTransportFallbackError(err)) {
                    gatewayLogger.warn("feishu_proxy_reply_fallback", {
                        reply_to_id: replyToId,
                        error: err.message,
                    });
                    return this.sendDirectWithClient(this.directClient, resolvedTarget, params);
                }
                if (!isWithdrawnReplyError(err)) {
                    throw err;
                }
                gatewayLogger.warn("feishu_reply_target_unavailable", {
                    reply_to_id: replyToId,
                    error: err.message,
                });
            }
        }
        return await this.sendDirectWithClient(client, resolvedTarget, params, allowDirectFallback);
    }
    async sendDirectWithClient(client, resolvedTarget, params, allowDirectFallback = false) {
        try {
            return await client.im.message.create({
                data: {
                    receive_id: resolvedTarget.receiveId,
                    msg_type: params.msgType,
                    content: params.content,
                },
                params: { receive_id_type: resolvedTarget.receiveIdType },
            });
        }
        catch (err) {
            if (allowDirectFallback && this.directClient && client !== this.directClient && isFeishuTransportFallbackError(err)) {
                gatewayLogger.warn("feishu_proxy_direct_fallback", {
                    receive_id: resolvedTarget.receiveId,
                    receive_id_type: resolvedTarget.receiveIdType,
                    error: err.message,
                });
                return this.sendDirectWithClient(this.directClient, resolvedTarget, params, false);
            }
            throw err;
        }
    }
}
function chunkText(text, limit) {
    if (text.length <= limit)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > limit) {
        let splitAt = remaining.lastIndexOf("\n", limit);
        if (splitAt < limit / 2)
            splitAt = remaining.lastIndexOf(" ", limit);
        if (splitAt < limit / 2)
            splitAt = limit;
        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining)
        chunks.push(remaining);
    return chunks;
}
function isFeishuTransportFallbackError(err) {
    if (typeof err !== "object" || err === null) {
        return false;
    }
    const response = err.response;
    if (response?.status === 502 || response?.status === 503 || response?.status === 504) {
        return true;
    }
    const code = err.code;
    return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT";
}
function isFeishuBackoffError(err) {
    if (typeof err !== "object" || err === null) {
        return false;
    }
    const response = err.response;
    if (response?.status === 429) {
        return true;
    }
    if (typeof response?.data?.code === "number" && FEISHU_BACKOFF_CODES.has(response.data.code)) {
        return true;
    }
    const code = err.code;
    return typeof code === "number" && FEISHU_BACKOFF_CODES.has(code);
}
function shouldFallbackFromReplyTarget(response) {
    if (response.code !== undefined && FEISHU_WITHDRAWN_REPLY_ERROR_CODES.has(response.code)) {
        return true;
    }
    const msg = response.msg?.toLowerCase() ?? "";
    return msg.includes("withdrawn") || msg.includes("not found");
}
function isWithdrawnReplyError(err) {
    if (typeof err !== "object" || err === null) {
        return false;
    }
    const code = err.code;
    if (typeof code === "number" && FEISHU_WITHDRAWN_REPLY_ERROR_CODES.has(code)) {
        return true;
    }
    const response = err.response;
    return typeof response?.data?.code === "number" &&
        FEISHU_WITHDRAWN_REPLY_ERROR_CODES.has(response.data.code);
}
