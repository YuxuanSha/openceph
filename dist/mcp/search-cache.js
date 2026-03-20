export class SearchCache {
    cache = new Map();
    ttlMs;
    constructor(ttlMinutes = 15) {
        this.ttlMs = ttlMinutes * 60 * 1000;
    }
    get(query) {
        const entry = this.cache.get(query);
        if (!entry)
            return null;
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(query);
            return null;
        }
        return entry.result;
    }
    set(query, result) {
        this.cache.set(query, {
            result,
            expiresAt: Date.now() + this.ttlMs,
        });
    }
    clear() {
        this.cache.clear();
    }
}
