/** Escape special characters for Telegram MarkdownV2 */
export declare function formatForTelegram(text: string): string;
/** Split long message into chunks at paragraph boundaries */
export declare function chunkMessage(text: string, limit?: number): string[];
