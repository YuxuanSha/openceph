import type { OpenCephConfig } from "../config/config-schema.js";
import { SessionStoreManager } from "../session/session-store.js";
export declare class SessionResetScheduler {
    private config;
    private dailyTask;
    private idleCheckTask;
    private sessionStore;
    constructor(config: OpenCephConfig, sessionStore?: SessionStoreManager);
    start(): void;
    stop(): void;
}
