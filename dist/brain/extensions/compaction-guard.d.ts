/**
 * Pi Extension: Compaction Guard
 * Hook: session_before_compact
 * Flushes important memory before compaction and protects critical messages.
 */
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
declare const compactionGuard: ExtensionFactory;
export default compactionGuard;
