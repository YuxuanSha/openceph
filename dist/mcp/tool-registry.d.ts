import type { ToolRegistryEntry } from "../tools/index.js";
import type { McpBridge } from "./mcp-bridge.js";
interface McpToolDefinition {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
/**
 * Convert an MCP tool definition to a Pi ToolDefinition.
 * Tool name is prefixed: mcp_{serverName}_{toolName}
 */
export declare function mcpToolToRegistryEntry(serverName: string, mcpTool: McpToolDefinition, bridge: McpBridge): ToolRegistryEntry;
export {};
