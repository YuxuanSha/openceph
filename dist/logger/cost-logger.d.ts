export declare function initCostLogger(logDir: string, level: string, maxSizeMb: number, keepDays: number): void;
export declare const costLogger: {
    info(event: string, meta?: Record<string, unknown>): void;
    warn(event: string, meta?: Record<string, unknown>): void;
    error(event: string, meta?: Record<string, unknown>): void;
    debug(event: string, meta?: Record<string, unknown>): void;
};
