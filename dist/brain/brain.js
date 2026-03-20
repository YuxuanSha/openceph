import { createBrainSession } from "../pi/pi-session.js";
import { SessionStoreManager } from "../session/session-store.js";
import { ToolRegistry } from "../tools/index.js";
import { createMemoryTools } from "../tools/memory-tools.js";
import { createUserTools } from "../tools/user-tools.js";
import { createSkillTools } from "../tools/skill-tools.js";
import { createWebTools } from "../tools/web-tools.js";
import { createSessionTools } from "../tools/session-tools.js";
import { createHeartbeatTools } from "../tools/heartbeat-tools.js";
import { createTentacleTools } from "../tools/tentacle-tools.js";
import { createCodeTools } from "../tools/code-tools.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import { isNewWorkspace } from "./context-assembler.js";
import { brainLogger, costLogger, writeCacheTrace } from "../logger/index.js";
import { IpcServer } from "../tentacle/ipc-server.js";
import { TentacleRegistry } from "../tentacle/registry.js";
import { PendingReportsQueue } from "../tentacle/pending-reports.js";
import { TentacleManager } from "../tentacle/manager.js";
import { LoopDetector } from "./loop-detection.js";
import { SkillLoader } from "../skills/skill-loader.js";
import { SkillSpawner } from "../skills/skill-spawner.js";
import { detectRuntimes } from "../tentacle/runtime-detector.js";
import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";
export class Brain {
    session = null;
    toolRegistry;
    sessionStore;
    config;
    piCtx;
    currentSessionKey = "";
    currentModel;
    lastActiveChannel = "cli";
    lastActiveSenderId = "local";
    totalInputTokens = 0;
    totalOutputTokens = 0;
    ipcServer;
    tentacleRegistry;
    pendingReports;
    tentacleManager;
    skillLoader;
    skillSpawner = null;
    constructor(options) {
        this.config = options.config;
        this.piCtx = options.piCtx;
        this.currentModel = options.config.agents.defaults.model.primary;
        this.sessionStore = new SessionStoreManager("ceph");
        this.toolRegistry = new ToolRegistry();
        this.ipcServer = new IpcServer(options.config.tentacle.ipcSocketPath);
        this.tentacleRegistry = new TentacleRegistry(options.piCtx.workspaceDir);
        this.pendingReports = new PendingReportsQueue(path.join(os.homedir(), ".openceph", "state", "pending-reports.json"));
        this.tentacleManager = new TentacleManager(options.config, this.ipcServer, this.tentacleRegistry, this.pendingReports);
        this.skillLoader = new SkillLoader(options.config.skills.paths);
        // Register memory tools
        for (const entry of createMemoryTools({
            workspaceDir: options.piCtx.workspaceDir,
            piCtx: options.piCtx,
            config: options.config,
        })) {
            this.toolRegistry.register(entry);
        }
        // Register user tools
        for (const entry of createUserTools({
            deliverToUser: options.deliverToUser,
            lastActiveChannel: () => this.lastActiveChannel,
            lastActiveSenderId: () => this.lastActiveSenderId,
        })) {
            this.toolRegistry.register(entry);
        }
        for (const entry of createSessionTools("ceph")) {
            this.toolRegistry.register(entry);
        }
        for (const entry of createHeartbeatTools(options.piCtx.workspaceDir)) {
            this.toolRegistry.register(entry);
        }
        for (const entry of createSkillTools(options.config.skills.paths)) {
            this.toolRegistry.register(entry);
        }
        // Register built-in web tools (search + fetch, no API key needed)
        for (const entry of createWebTools()) {
            this.toolRegistry.register(entry);
        }
    }
    async initialize() {
        await this.ipcServer.start();
        await this.tentacleManager.restoreFromRegistry();
        await this.skillLoader.loadAll();
        if (!this.skillSpawner) {
            this.skillSpawner = new SkillSpawner(this.config, this.skillLoader, this.tentacleManager, await detectRuntimes());
            for (const entry of createTentacleTools(this.tentacleManager, this.config.logging.logDir, this.skillSpawner)) {
                this.toolRegistry.register(entry);
            }
            for (const entry of createCodeTools({
                config: this.config,
                piCtx: this.piCtx,
                tentacleManager: this.tentacleManager,
            })) {
                this.toolRegistry.register(entry);
            }
        }
        // Auto-generate TOOLS.md from registered tools so it's always in sync
        await this.syncToolsMd();
        brainLogger.info("brain_initialize", {
            model: this.currentModel,
            tools: this.toolRegistry.size,
        });
    }
    /** Write TOOLS.md to workspace dir based on actually registered tools */
    async syncToolsMd() {
        const toolsMdPath = path.join(this.piCtx.workspaceDir, "TOOLS.md");
        const groups = new Map();
        for (const entry of this.toolRegistry.getAll()) {
            const list = groups.get(entry.group) || [];
            list.push({ name: entry.name, description: entry.description });
            groups.set(entry.group, list);
        }
        const groupLabels = {
            user: "核心工具",
            messaging: "消息工具",
            memory: "记忆工具",
            web: "网页工具",
            sessions: "会话工具",
            skill: "技能工具",
            heartbeat: "Heartbeat 工具",
            tentacle: "触手工具",
            code: "代码工具",
            mcp: "MCP 工具",
        };
        let md = "# TOOLS.md — 工具使用指南\n";
        for (const [group, tools] of groups) {
            md += `\n## ${groupLabels[group] || group}\n`;
            for (const t of tools) {
                md += `${t.name} — ${t.description}\n`;
            }
        }
        md += `\n## 工具使用原则\n`;
        md += `- 能直接回答的不调工具\n`;
        md += `- 当前这轮对话的正常回复，直接输出文本；不要调用 send_to_user\n`;
        md += `- send_to_user 只用于主动通知、异步提醒、非当前会话的外呼\n`;
        md += `- 用户说"搜一下""查一下""找一下""新闻"等需要实时信息时，必须调用 web_search\n`;
        md += `- 如果没有实际调用过 web_search，绝不能声称"已经搜过了"\n`;
        md += `- 搜索结果直接在回复中总结，不需要再调用 send_to_user\n`;
        md += `- web_fetch 不执行 JS，JS 重度页面需注意\n`;
        await fs.writeFile(toolsMdPath, md, "utf-8");
    }
    /** Register additional tools (e.g. MCP tools discovered after Brain construction) */
    async registerTools(entries) {
        for (const entry of entries) {
            this.toolRegistry.register(entry);
        }
        brainLogger.info("tools_registered", {
            added: entries.length,
            total: this.toolRegistry.size,
            names: entries.map(e => e.name),
        });
        // Re-sync TOOLS.md with the new tools
        await this.syncToolsMd();
    }
    async handleMessage(input) {
        const startTime = Date.now();
        this.lastActiveChannel = input.channel;
        this.lastActiveSenderId = input.senderId;
        // Ensure session exists
        const sessionEntry = await this.sessionStore.getOrCreate(input.sessionKey, {
            model: this.currentModel,
            origin: { channel: input.channel, senderId: input.senderId },
        });
        this.currentSessionKey = input.sessionKey;
        // Assemble system prompt
        const newWs = await isNewWorkspace(this.piCtx.workspaceDir);
        const promptOptions = {
            mode: "full",
            channel: input.channel,
            isDm: input.isDm,
            isNewWorkspace: newWs,
            model: this.currentModel,
            thinkingLevel: "off",
            hostname: os.hostname(),
            nodeVersion: process.version,
            osPlatform: process.platform,
            osArch: process.arch,
            tentacleSummary: this.listTentacles().length > 0
                ? this.listTentacles().map((item) => `${item.tentacleId} (${item.status})`).join("\n")
                : undefined,
            skillsSummary: await this.loadSkillsSummary(),
        };
        const systemPrompt = await assembleSystemPrompt(this.piCtx.workspaceDir, promptOptions, this.toolRegistry);
        // Create or reuse brain session
        if (!this.session) {
            const customTools = this.toolRegistry.getPiTools();
            brainLogger.info("session_create", {
                session_id: sessionEntry.sessionId,
                model: this.currentModel,
                custom_tools_count: customTools.length,
                custom_tool_names: customTools.map(t => t.name),
            });
            this.session = await createBrainSession(this.piCtx, this.config, {
                sessionFilePath: this.sessionStore.getTranscriptPath(sessionEntry.sessionId),
                modelId: this.currentModel,
                systemPrompt,
                customTools,
            });
        }
        // System prompt is set at session creation; extensions (memory-injector)
        // dynamically update it via before_agent_start hook each turn
        // Collect output
        let replyText = "";
        let errorMessage = "";
        const toolCalls = [];
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let loopAborted = false;
        const loopDetector = new LoopDetector(this.config.tools.loopDetection);
        const pendingToolArgs = new Map();
        const unsubscribe = this.session.session.subscribe((event) => {
            switch (event.type) {
                case "message_update":
                    if (event.assistantMessageEvent?.type === "text_delta") {
                        replyText += event.assistantMessageEvent.delta;
                        input.onTextDelta?.(event.assistantMessageEvent.delta);
                    }
                    break;
                case "message_complete":
                    if (event.message?.stopReason === "error" && event.message?.errorMessage) {
                        errorMessage = event.message.errorMessage;
                        brainLogger.error("api_error", {
                            session_id: sessionEntry.sessionId,
                            error: event.message.errorMessage,
                        });
                    }
                    break;
                case "tool_execution_start":
                    pendingToolArgs.set(event.toolCallId, event.args);
                    brainLogger.info("tool_call", {
                        session_id: sessionEntry.sessionId,
                        tool: event.toolName,
                    });
                    break;
                case "tool_execution_end":
                    loopDetector.record(event.toolName, pendingToolArgs.get(event.toolCallId), event.result);
                    pendingToolArgs.delete(event.toolCallId);
                    brainLogger.info("tool_result", {
                        session_id: sessionEntry.sessionId,
                        tool: event.toolName,
                        success: !event.isError,
                    });
                    toolCalls.push({
                        name: event.toolName,
                        success: !event.isError,
                    });
                    {
                        const loopResult = loopDetector.check();
                        if (loopResult.detected) {
                            brainLogger.warn("loop_detected", {
                                session_id: sessionEntry.sessionId,
                                level: loopResult.level,
                                detector: loopResult.detector,
                                message: loopResult.message,
                            });
                            if (loopResult.level === "critical" && !loopAborted) {
                                loopAborted = true;
                                void this.session?.session.abort();
                            }
                        }
                    }
                    break;
            }
        });
        brainLogger.info("streaming_start", { session_id: sessionEntry.sessionId });
        // Capture token counts before prompt for computing deltas
        const statsBefore = this.session.session.getSessionStats();
        try {
            await this.session.session.prompt(input.text);
        }
        finally {
            unsubscribe();
        }
        // Compute token usage delta for this turn
        const statsAfter = this.session.session.getSessionStats();
        inputTokens = statsAfter.tokens.input - statsBefore.tokens.input;
        outputTokens = statsAfter.tokens.output - statsBefore.tokens.output;
        cacheReadTokens = statsAfter.tokens.cacheRead - statsBefore.tokens.cacheRead;
        cacheWriteTokens = statsAfter.tokens.cacheWrite - statsBefore.tokens.cacheWrite;
        const durationMs = Date.now() - startTime;
        if (loopAborted && !replyText.trim()) {
            replyText = "检测到工具调用循环，已中止。";
        }
        brainLogger.info("streaming_end", {
            session_id: sessionEntry.sessionId,
            chars: replyText.length,
            duration_ms: durationMs,
        });
        // Write cost log
        costLogger.info("api_call", {
            session_id: sessionEntry.sessionId,
            model: this.currentModel,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_tokens: cacheReadTokens,
            cache_write_tokens: cacheWriteTokens,
            duration_ms: durationMs,
        });
        // Write cache trace
        if (this.config.logging.cacheTrace) {
            writeCacheTrace({
                session_id: sessionEntry.sessionId,
                model: this.currentModel,
                cache_read_tokens: cacheReadTokens,
                cache_write_tokens: cacheWriteTokens,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
            });
        }
        // Update session token counts
        await this.sessionStore.updateTokens(input.sessionKey, {
            input: inputTokens,
            output: outputTokens,
        });
        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;
        return {
            text: replyText,
            errorMessage: errorMessage || undefined,
            toolCalls,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            model: this.currentModel,
            durationMs,
        };
    }
    getSessionStatus() {
        return {
            sessionKey: this.currentSessionKey,
            model: this.currentModel,
            inputTokens: this.totalInputTokens,
            outputTokens: this.totalOutputTokens,
            activeTentacles: this.tentacleManager.listAll({ status: "running" }).length,
            todayCostUsd: 0,
        };
    }
    async resetSession(newModel, sessionKey) {
        if (newModel)
            this.currentModel = newModel;
        const key = sessionKey || this.currentSessionKey;
        if (key) {
            await this.sessionStore.reset(key, "manual");
        }
        this.session = null;
        this.totalInputTokens = 0;
        this.totalOutputTokens = 0;
        brainLogger.info("session_reset", {
            session_key: key,
            new_model: this.currentModel,
        });
    }
    async shutdown() {
        await this.tentacleManager.shutdown();
        await this.ipcServer.stop();
        this.session = null;
        brainLogger.info("brain_shutdown", {});
    }
    get model() {
        return this.currentModel;
    }
    listTentacles() {
        return this.tentacleManager.listAll();
    }
    async loadSkillsSummary() {
        const skills = await new SkillLoader(this.config.skills.paths).loadAll();
        if (skills.length === 0)
            return undefined;
        return skills.map((skill) => `${skill.name} — ${skill.description || "No description"}${skill.spawnable ? " [spawnable]" : ""}`).join("\n");
    }
}
