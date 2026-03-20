import { type MemorySearchResult } from "./memory-search.js";
import type { MemoryDistiller } from "./memory-distiller.js";
export declare class MemoryManager {
    private workspaceDir;
    private memoryDir;
    private memoryMdPath;
    private searchEngine;
    constructor(workspaceDir: string);
    /** Read MEMORY.md full content or a specific section */
    readMemory(section?: string, query?: string): Promise<string>;
    /** Write a memory entry to daily log memory/YYYY-MM-DD.md */
    writeMemory(content: string, section: string, tags?: string[]): Promise<string>;
    /** Update an existing memory entry by ID */
    updateMemory(memoryId: string, content: string): Promise<void>;
    /** Delete a memory entry by ID */
    deleteMemory(memoryId: string): Promise<void>;
    /** Read a specific memory file */
    getMemoryFile(relativePath: string, lineRange?: {
        start: number;
        end: number;
    }): Promise<string>;
    searchMemory(query: string, options?: {
        topK?: number;
        includeTranscripts?: boolean;
    }): Promise<MemorySearchResult[]>;
    /** Distill daily log into MEMORY.md (M1: simple append, M2: LLM-assisted) */
    distillMemory(date?: string, distiller?: MemoryDistiller): Promise<void>;
}
