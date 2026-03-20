export interface CacheTraceEntry {
    session_id: string;
    model: string;
    cache_read_tokens: number;
    cache_write_tokens: number;
    input_tokens: number;
    output_tokens: number;
}
export declare function initCacheTraceLogger(logDir: string): void;
export declare function writeCacheTrace(entry: CacheTraceEntry): Promise<void>;
