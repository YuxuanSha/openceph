import type { OpenCephConfig } from "../../config/config-schema.js";
export declare class AuthProfileManager {
    private config;
    private cooldowns;
    private cooldownMs;
    constructor(config: OpenCephConfig);
    /** Get the active profile for a provider (skip cooldown ones) */
    getActiveProfile(provider: string): {
        profileId: string;
        apiKey?: string;
    } | null;
    /** Mark a profile as in cooldown (after 429/401) */
    markCooldown(profileId: string): void;
    isInCooldown(profileId: string): boolean;
}
