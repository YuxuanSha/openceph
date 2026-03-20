import type { PairingEntry } from "./adapters/channel-plugin.js";
export declare class PairingManager {
    private statePath;
    private store;
    constructor(statePath: string);
    isApproved(channel: string, senderId: string): boolean;
    requestCode(channel: string, senderId: string): Promise<string>;
    approve(code: string): Promise<boolean>;
    reject(code: string): Promise<boolean>;
    revoke(channel: string, senderId: string): Promise<boolean>;
    list(channel?: string): Promise<PairingEntry[]>;
    cleanup(): void;
    private load;
    private save;
}
