export interface SessionEntry {
    sessionId: string;
    sessionKey: string;
    createdAt: string;
    updatedAt: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    origin?: {
        channel?: string;
        senderId?: string;
    };
}
export declare class SessionStoreManager {
    private agentId;
    private baseDir;
    constructor(agentId: string);
    get storePath(): string;
    getTranscriptPath(sessionId: string): string;
    getOrCreate(sessionKey: string, meta?: Partial<Pick<SessionEntry, "model" | "origin">>): Promise<SessionEntry>;
    get(sessionKey: string): Promise<SessionEntry | undefined>;
    updateModel(sessionKey: string, model: string): Promise<void>;
    updateTokens(sessionKey: string, delta: {
        input: number;
        output: number;
    }): Promise<void>;
    reset(sessionKey: string, reason: "manual" | "daily" | "idle"): Promise<SessionEntry>;
    list(filter?: {
        activeWithinMinutes?: number;
    }): Promise<SessionEntry[]>;
    appendAssistantMessage(targetSessionKey: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
    resolveSessionKeyByTranscriptPath(transcriptPath: string): Promise<string | undefined>;
    cleanup(cleanupConfig: {
        maxArchiveFilesPerKey: number;
        archiveTtlDays: number;
    }): Promise<{
        deletedFiles: number;
        freedBytes: number;
    }>;
    private readStore;
    private writeStore;
    private ensureDir;
    private withLock;
}
