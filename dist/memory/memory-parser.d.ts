/**
 * Markdown memory file parser and serializer.
 */
/** Parse markdown content into sections by ## headings */
export declare function parseSections(content: string): Map<string, string>;
/** Replace a section's content while preserving other sections. */
export declare function updateSection(content: string, sectionName: string, newContent: string): string;
/** Append content to a section, creating the section if needed. */
export declare function appendToSection(content: string, sectionName: string, newEntry: string): string;
/** Generate a stable daily memory ID. */
export declare function generateMemoryId(date: string, existingContent: string): string;
export interface ParsedMemoryEntry {
    section: string;
    memoryId: string;
    block: string;
    body: string;
}
/** Parse markdown memory entries grouped by section. */
export declare function parseMemoryEntries(content: string): ParsedMemoryEntry[];
/** Find a memory entry by its ID marker in content */
export declare function findMemoryById(content: string, memoryId: string): {
    start: number;
    end: number;
    text: string;
} | null;
/** Replace a memory entry's content by ID */
export declare function replaceMemoryById(content: string, memoryId: string, newText: string): string;
/** Delete a memory entry by ID */
export declare function deleteMemoryById(content: string, memoryId: string): string;
export declare function normalizeMemoryId(memoryId: string): string;
