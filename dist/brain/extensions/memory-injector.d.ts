/**
 * Pi Extension: Memory Injector
 * Hook: before_agent_start
 * Reads MEMORY.md + USER.md and injects into system prompt.
 */
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
declare const memoryInjector: ExtensionFactory;
export default memoryInjector;
