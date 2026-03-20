export declare class SearchCache {
    private cache;
    private ttlMs;
    constructor(ttlMinutes?: number);
    get(query: string): unknown | null;
    set(query: string, result: unknown): void;
    clear(): void;
}
