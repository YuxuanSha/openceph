/** Escape special characters for Telegram MarkdownV2 */
export function formatForTelegram(text) {
    // Characters that need escaping in MarkdownV2
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
/** Split long message into chunks at paragraph boundaries */
export function chunkMessage(text, limit = 4000) {
    if (text.length <= limit)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }
        // Try to split at paragraph boundary
        let splitIdx = remaining.lastIndexOf("\n\n", limit);
        if (splitIdx === -1 || splitIdx < limit / 2) {
            // Try single newline
            splitIdx = remaining.lastIndexOf("\n", limit);
        }
        if (splitIdx === -1 || splitIdx < limit / 2) {
            // Hard split
            splitIdx = limit;
        }
        chunks.push(remaining.slice(0, splitIdx));
        remaining = remaining.slice(splitIdx).trimStart();
    }
    return chunks;
}
