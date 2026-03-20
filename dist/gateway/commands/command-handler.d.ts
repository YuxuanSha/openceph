import type { Brain } from "../../brain/brain.js";
import type { OpenCephConfig } from "../../config/config-schema.js";
export interface CommandContext {
    channel: string;
    senderId: string;
    sessionKey: string;
    brain: Brain;
    config: OpenCephConfig;
}
export interface CommandExecutor {
    execute(args: string[], context: CommandContext): Promise<string>;
}
export declare class CommandHandler {
    private commands;
    private aliases;
    register(command: string, executor: CommandExecutor): void;
    registerAlias(alias: string, target: string): void;
    execute(text: string, context: CommandContext): Promise<string | null>;
}
