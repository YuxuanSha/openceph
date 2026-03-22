import type { ChannelPlugin } from "./adapters/channel-plugin.js";
export interface DiscoveredPlugin {
    packageName: string;
    channelId: string;
    displayName: string;
    version: string;
    entryPath: string;
}
export interface LoadedPlugin {
    info: DiscoveredPlugin;
    instance: ChannelPlugin;
}
export interface PluginLoaderConfig {
    autoDiscover: boolean;
    allowedPackageScopes: string[];
}
/**
 * M3 full plugin loader: discovery → scope filter → dynamic import →
 * interface validation → register to Gateway → hot-reload.
 */
export declare class PluginLoader {
    private projectRoot;
    private pluginConfig?;
    private loaded;
    constructor(projectRoot: string, pluginConfig?: PluginLoaderConfig | undefined);
    /** Discover all openceph-channel packages in node_modules. */
    discover(): Promise<DiscoveredPlugin[]>;
    /** Load a discovered plugin: dynamic import + interface validation. */
    load(plugin: DiscoveredPlugin): Promise<LoadedPlugin>;
    /** Discover and load all plugins. Returns successfully loaded ones. */
    discoverAndLoadAll(): Promise<LoadedPlugin[]>;
    /** Reload a specific plugin by channelId. */
    reload(channelId: string): Promise<LoadedPlugin | null>;
    /** Unload a plugin by channelId. */
    unload(channelId: string): Promise<boolean>;
    /** Get all loaded plugins. */
    getLoaded(): LoadedPlugin[];
    /** Get a loaded plugin by channelId. */
    getPlugin(channelId: string): LoadedPlugin | undefined;
    /** Validate that an object implements the ChannelPlugin interface. */
    private validateInterface;
    private checkPackage;
}
