export interface WorkspaceFile {
    name: string;
    path: string;
    content: string;
    originalLength: number;
    truncated: boolean;
}
/** Read workspace files with per-file and total character limits */
export declare function loadWorkspaceFiles(workspaceDir: string, fileNames: string[], maxCharsPerFile: number, totalMaxChars: number): Promise<WorkspaceFile[]>;
/** Check if this is a first-run workspace (BOOTSTRAP.md exists + USER.md is default template) */
export declare function isNewWorkspace(workspaceDir: string): Promise<boolean>;
