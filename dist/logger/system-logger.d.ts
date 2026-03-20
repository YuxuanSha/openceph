export declare function initSystemLogger(logDir: string, level: string, maxSizeMb: number, keepDays: number): void;
export declare const systemLogger: {
    info(event: string, meta?: Record<string, unknown>): void;
    warn(event: string, meta?: Record<string, unknown>): void;
    error(event: string, meta?: Record<string, unknown>): void;
    debug(event: string, meta?: Record<string, unknown>): void;
};
