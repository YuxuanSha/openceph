import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
/** Read workspace files with per-file and total character limits */
export async function loadWorkspaceFiles(workspaceDir, fileNames, maxCharsPerFile, totalMaxChars) {
    const files = [];
    let totalChars = 0;
    for (const name of fileNames) {
        const filePath = path.join(workspaceDir, name);
        try {
            const raw = await fs.readFile(filePath, "utf-8");
            const originalLength = raw.length;
            let content = raw;
            let truncated = false;
            // Per-file limit
            if (content.length > maxCharsPerFile) {
                content = content.slice(0, maxCharsPerFile) + `\n<!-- truncated at ${maxCharsPerFile} chars -->\n`;
                truncated = true;
            }
            // Total limit
            if (totalChars + content.length > totalMaxChars) {
                const remaining = totalMaxChars - totalChars;
                if (remaining > 200) {
                    content = content.slice(0, remaining) + `\n<!-- truncated: total limit reached -->\n`;
                    truncated = true;
                }
                else {
                    // Skip this file entirely
                    continue;
                }
            }
            totalChars += content.length;
            files.push({ name, path: filePath, content, originalLength, truncated });
        }
        catch {
            // File doesn't exist — skip with warning (caller logs)
        }
    }
    return files;
}
/** Check if this is a first-run workspace (BOOTSTRAP.md exists + USER.md is default template) */
export async function isNewWorkspace(workspaceDir) {
    const bootstrapPath = path.join(workspaceDir, "BOOTSTRAP.md");
    const userPath = path.join(workspaceDir, "USER.md");
    if (!existsSync(bootstrapPath))
        return false;
    try {
        const userContent = await fs.readFile(userPath, "utf-8");
        // Check if USER.md still has the template placeholder
        return userContent.includes("{{") || userContent.includes("请回答以下") || userContent.length < 200;
    }
    catch {
        return true; // No USER.md means new workspace
    }
}
