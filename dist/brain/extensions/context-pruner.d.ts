/**
 * Pi Extension: Context Pruner
 * Hook: context
 * Truncates old/large tool_results to save context space.
 * cache-ttl mode: prune tool_results older than TTL for Anthropic models.
 */
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
declare const contextPruner: ExtensionFactory;
export default contextPruner;
