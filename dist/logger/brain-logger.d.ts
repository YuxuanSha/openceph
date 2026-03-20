export declare function initBrainLogger(logDir: string, level: string, maxSizeMb: number, keepDays: number): void;
export declare const brainLogger: {
    info(event: string, meta?: Record<string, unknown>): void;
    warn(event: string, meta?: Record<string, unknown>): void;
    error(event: string, meta?: Record<string, unknown>): void;
    debug(event: string, meta?: Record<string, unknown>): void;
};
