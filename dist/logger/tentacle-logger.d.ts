export declare function initTentacleLoggerConfig(dir: string, level: string, sizeMb: number, days: number): void;
export declare function tentacleLog(tentacleId: string, level: "info" | "warn" | "error" | "debug", event: string, meta?: Record<string, unknown>): void;
