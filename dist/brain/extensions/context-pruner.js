const MIN_PRUNABLE_CHARS = 5000;
const SOFT_TRIM_MAX_CHARS = 50000;
const KEEP_LAST_ASSISTANTS = 3;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const contextPruner = (pi) => {
    pi.on("context", async (event) => {
        const messages = [...event.messages];
        if (messages.length === 0)
            return { messages };
        const now = Date.now();
        // Find indices of the last N assistant messages
        const assistantIndices = [];
        for (let i = messages.length - 1; i >= 0 && assistantIndices.length < KEEP_LAST_ASSISTANTS; i--) {
            if (messages[i].role === "assistant") {
                assistantIndices.push(i);
            }
        }
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            // Only process tool_result messages
            if (msg.role !== "tool" && !msg.content?.some?.((c) => c.type === "tool_result"))
                continue;
            // Skip recent assistant context
            if (assistantIndices.includes(i) || assistantIndices.includes(i - 1))
                continue;
            // Check message age (estimate from position — earlier = older)
            const ageRatio = i / messages.length;
            const estimatedAge = ageRatio * (now - messages[0]?.timestamp || CACHE_TTL_MS * 2);
            if (estimatedAge < CACHE_TTL_MS)
                continue;
            // Truncate large tool results
            const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            if (content.length > MIN_PRUNABLE_CHARS && content.length > SOFT_TRIM_MAX_CHARS) {
                const truncated = content.slice(0, SOFT_TRIM_MAX_CHARS) +
                    `\n[pruned: original ${content.length} chars]`;
                messages[i] = { ...msg, content: truncated };
            }
        }
        return { messages };
    });
};
export default contextPruner;
