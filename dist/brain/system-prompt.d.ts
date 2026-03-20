import type { ToolRegistry } from "../tools/index.js";
export interface SystemPromptOptions {
    mode: "full" | "minimal" | "none";
    channel: string;
    isDm: boolean;
    isNewWorkspace: boolean;
    model: string;
    thinkingLevel: string;
    hostname: string;
    nodeVersion: string;
    osPlatform: string;
    osArch: string;
    tentacleSummary?: string;
    pendingReports?: number;
    skillsSummary?: string;
}
export declare function assembleSystemPrompt(workspaceDir: string, options: SystemPromptOptions, toolRegistry?: ToolRegistry): Promise<string>;
