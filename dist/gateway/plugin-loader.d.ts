export interface DiscoveredPlugin {
    packageName: string;
    channelId: string;
    displayName: string;
    version: string;
    entryPath: string;
}
/**
 * M1 lightweight plugin loader: discovery + logging only, no actual loading.
 */
export declare class PluginLoader {
    private projectRoot;
    constructor(projectRoot: string);
    discover(): Promise<DiscoveredPlugin[]>;
    private checkPackage;
}
