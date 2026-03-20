import { Type } from "@sinclair/typebox";
/**
 * Convert an MCP tool definition to a Pi ToolDefinition.
 * Tool name is prefixed: mcp_{serverName}_{toolName}
 */
export function mcpToolToRegistryEntry(serverName, mcpTool, bridge) {
    const fullName = `mcp_${serverName}_${mcpTool.name}`;
    // Convert JSON Schema to a TypeBox-like passthrough
    // For MCP tools, we use a generic object parameter since
    // the actual schema varies per tool
    const desc = mcpTool.description ?? `MCP tool: ${serverName}/${mcpTool.name}`;
    const tool = {
        name: fullName,
        label: `MCP: ${mcpTool.name}`,
        description: desc,
        promptSnippet: `${fullName} — ${desc}`,
        parameters: Type.Object({
            input: Type.Optional(Type.Any({ description: "Tool input parameters" })),
        }),
        async execute(_id, params) {
            const result = await bridge.call(serverName, mcpTool.name, params.input ?? {});
            return {
                content: [{
                        type: "text",
                        text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
                    }],
                details: undefined,
            };
        },
    };
    return {
        name: fullName,
        description: tool.description,
        group: `mcp:${serverName}`,
        tool,
    };
}
