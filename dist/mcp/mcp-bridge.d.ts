import type { OpenCephConfig } from "../config/config-schema.js";
import type { ToolRegistryEntry } from "../tools/index.js";
/**
 * MCP Bridge: manages MCP server processes and exposes their tools.
 * M1: basic stdio transport for command-type servers.
 */
export declare class McpBridge {
    private servers;
    private searchCache;
    private config;
    constructor(config: OpenCephConfig);
    init(): Promise<void>;
    private startCommandServer;
    private scheduleReconnect;
    private initializeServer;
    private listTools;
    /** Get all MCP tools as ToolRegistryEntries */
    getTools(): ToolRegistryEntry[];
    /** Execute an MCP tool call */
    call(serverName: string, toolName: string, input: unknown): Promise<unknown>;
    shutdown(): Promise<void>;
}
