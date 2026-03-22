import { ChannelRouter } from "./router.js";
import { PairingManager } from "./pairing.js";
import { SessionResolver } from "./session-manager.js";
import { MessageQueue } from "./message-queue.js";
import { AuthProfileManager } from "./auth/auth-profiles.js";
import { PluginLoader } from "./plugin-loader.js";
import { gatewayLogger } from "../logger/index.js";
import { updateRuntimeStatus } from "../logger/runtime-status-store.js";
import * as path from "path";
import * as os from "os";
import { existsSync, watch } from "fs";
import * as fs from "fs/promises";
export class Gateway {
    channelPlugins = new Map();
    router;
    messageQueue;
    sessionResolver;
    pairingManager;
    authProfileManager;
    brain;
    config;
    pluginLoader;
    pluginOpsPath;
    pluginStatePath;
    pluginOpsWatcher = null;
    constructor(config, brain) {
        this.config = config;
        this.brain = brain;
        this.messageQueue = new MessageQueue();
        this.sessionResolver = new SessionResolver(config);
        this.pairingManager = new PairingManager(path.join(os.homedir(), ".openceph", "state", "pairing.json"));
        this.authProfileManager = new AuthProfileManager(config);
        this.pluginLoader = new PluginLoader(process.cwd(), config.plugins);
        this.pluginOpsPath = path.join(os.homedir(), ".openceph", "state", "plugin-ops.json");
        this.pluginStatePath = path.join(os.homedir(), ".openceph", "state", "plugin-state.json");
    }
    async start() {
        // Create router
        this.router = new ChannelRouter(this.channelPlugins, this.pairingManager, this.sessionResolver, this.messageQueue, this.brain, this.config);
        try {
            const loaded = await this.pluginLoader.discoverAndLoadAll();
            for (const plugin of loaded) {
                this.registerChannel(plugin.instance);
            }
            await this.writePluginState();
        }
        catch {
            // non-fatal
        }
        // Register and start core channel adapters
        for (const [channelId, plugin] of this.channelPlugins) {
            const channelCfg = this.config.channels?.[channelId];
            if (channelCfg && channelCfg.enabled === false && channelId !== "cli")
                continue;
            try {
                await plugin.initialize({ enabled: true, dmPolicy: plugin.defaultDmPolicy, allowFrom: [], streaming: true, ...channelCfg }, {});
                plugin.onMessage((msg) => this.router.route(msg));
                await plugin.start();
                gatewayLogger.info("channel_start", { channel: channelId });
            }
            catch (err) {
                gatewayLogger.error("channel_error", {
                    channel: channelId,
                    error: err.message,
                });
            }
        }
        await this.watchPluginOps();
        await updateRuntimeStatus((current) => ({
            ...current,
            gateway: {
                running: true,
                pid: process.pid,
                port: this.config.gateway.port,
                channels: Array.from(this.channelPlugins.keys()),
                plugins: this.pluginLoader.getLoaded().map((plugin) => plugin.info.channelId),
                updatedAt: new Date().toISOString(),
            },
        }));
        gatewayLogger.info("gateway_start", {
            channels: Array.from(this.channelPlugins.keys()),
        });
    }
    async stop() {
        this.pluginOpsWatcher?.close();
        this.pluginOpsWatcher = null;
        for (const [channelId, plugin] of this.channelPlugins) {
            try {
                await plugin.stop();
                gatewayLogger.info("channel_stop", { channel: channelId });
            }
            catch (err) {
                gatewayLogger.error("channel_stop_error", { channel: channelId, error: err.message });
            }
        }
        await updateRuntimeStatus((current) => ({
            ...current,
            gateway: {
                running: false,
                pid: process.pid,
                port: this.config.gateway.port,
                channels: Array.from(this.channelPlugins.keys()),
                plugins: this.pluginLoader.getLoaded().map((plugin) => plugin.info.channelId),
                updatedAt: new Date().toISOString(),
            },
        }));
        gatewayLogger.info("gateway_stop", {});
    }
    registerChannel(plugin) {
        this.channelPlugins.set(plugin.channelId, plugin);
    }
    async deliverToUser(target, content) {
        const channel = this.channelPlugins.get(target.channel);
        if (!channel) {
            gatewayLogger.warn("deliver_no_channel", { channel: target.channel });
            // Fallback: try any available channel
            for (const [, plugin] of this.channelPlugins) {
                try {
                    await plugin.send(target, content);
                    gatewayLogger.info("message_delivered", { channel: plugin.channelId, fallback: true });
                    return;
                }
                catch { /* try next */ }
            }
            // Last resort: log to stdout
            console.log(`[Ceph → ${target.recipientId ?? target.senderId}] ${content.text}`);
            return;
        }
        await channel.send(target, content);
        gatewayLogger.info("message_delivered", { channel: target.channel });
    }
    get pairing() {
        return this.pairingManager;
    }
    async watchPluginOps() {
        await fs.mkdir(path.dirname(this.pluginOpsPath), { recursive: true });
        if (!existsSync(this.pluginOpsPath)) {
            await fs.writeFile(this.pluginOpsPath, JSON.stringify({ type: "noop" }, null, 2), "utf-8");
        }
        this.pluginOpsWatcher?.close();
        this.pluginOpsWatcher = watch(this.pluginOpsPath, async () => {
            await this.handlePluginOperation().catch((error) => {
                gatewayLogger.error("plugin_hot_reload_failed", { error: error.message });
            });
        });
    }
    async handlePluginOperation() {
        let op;
        try {
            op = JSON.parse(await fs.readFile(this.pluginOpsPath, "utf-8"));
        }
        catch {
            return;
        }
        if (!op.type || op.type === "noop")
            return;
        if (op.type === "install" && op.packageName) {
            const discovered = await this.pluginLoader.discover();
            const target = discovered.find((plugin) => plugin.packageName === op.packageName || plugin.packageName.endsWith(`/${op.packageName}`));
            if (target) {
                const loaded = await this.pluginLoader.load(target);
                this.registerChannel(loaded.instance);
                await this.startPlugin(loaded.instance);
                await this.writePluginState();
            }
        }
        if (op.type === "uninstall" && op.packageName) {
            const loaded = this.pluginLoader.getLoaded().find((plugin) => plugin.info.packageName === op.packageName || plugin.info.packageName.endsWith(`/${op.packageName}`));
            if (loaded) {
                await this.pluginLoader.unload(loaded.info.channelId);
                this.channelPlugins.delete(loaded.info.channelId);
                await this.writePluginState();
            }
        }
        await fs.writeFile(this.pluginOpsPath, JSON.stringify({ type: "noop", handledAt: new Date().toISOString() }, null, 2), "utf-8");
    }
    async startPlugin(plugin) {
        const channelCfg = this.config.channels?.[plugin.channelId];
        await plugin.initialize({ enabled: true, dmPolicy: plugin.defaultDmPolicy, allowFrom: [], streaming: true, ...channelCfg }, {});
        plugin.onMessage((msg) => this.router.route(msg));
        await plugin.start();
        gatewayLogger.info("plugin_hot_loaded", { channel: plugin.channelId });
    }
    async writePluginState() {
        await fs.mkdir(path.dirname(this.pluginStatePath), { recursive: true });
        await fs.writeFile(this.pluginStatePath, JSON.stringify({
            loaded: this.pluginLoader.getLoaded().map((plugin) => ({
                packageName: plugin.info.packageName,
                channelId: plugin.info.channelId,
                displayName: plugin.info.displayName,
                version: plugin.info.version,
            })),
            updatedAt: new Date().toISOString(),
        }, null, 2), "utf-8");
    }
}
