import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
export interface ToolRegistryEntry {
    name: string;
    description: string;
    group: string;
    tool: ToolDefinition<any, any>;
}
export declare class ToolRegistry {
    private entries;
    register(entry: ToolRegistryEntry): void;
    getAll(): ToolRegistryEntry[];
    getByGroup(group: string): ToolRegistryEntry[];
    /** Return all tool definitions for passing to createAgentSession({ customTools }) */
    getPiTools(): ToolDefinition<any, any>[];
    /** Return "name — description" list for System Prompt Section 2 */
    getToolSummary(): string;
    get(name: string): ToolRegistryEntry | undefined;
    get size(): number;
}
