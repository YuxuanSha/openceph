import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
const compactionGuard = (pi) => {
    const workspaceDir = path.join(os.homedir(), ".openceph", "workspace");
    pi.on("session_before_compact", async (event) => {
        const today = new Date().toISOString().slice(0, 10);
        const dailyLogPath = path.join(workspaceDir, "memory", `${today}.md`);
        // Check if today's memory log exists
        try {
            await fs.access(dailyLogPath);
        }
        catch {
            // No daily log yet — extract key points from conversation and write them
            try {
                const entries = event.branchEntries || [];
                const keyPoints = [];
                for (const entry of entries) {
                    const data = entry;
                    // Protect tool_call failure records
                    if (data.toolName && data.isError) {
                        keyPoints.push(`- Tool failure: ${data.toolName}`);
                    }
                    // Protect send_to_user calls
                    if (data.toolName === "send_to_user") {
                        keyPoints.push(`- Sent message to user via ${data.toolName}`);
                    }
                    // Protect "remember" requests
                    if (typeof data.content === "string") {
                        const text = data.content.toLowerCase();
                        if (text.includes("记住") || text.includes("记下来") || text.includes("remember")) {
                            keyPoints.push(`- User asked to remember: ${data.content.slice(0, 200)}`);
                        }
                    }
                }
                if (keyPoints.length > 0) {
                    await fs.mkdir(path.dirname(dailyLogPath), { recursive: true });
                    const header = `# Memory Log ${today}\n\n## Pre-compaction flush\n`;
                    await fs.writeFile(dailyLogPath, header + keyPoints.join("\n") + "\n", "utf-8");
                }
            }
            catch {
                // Non-fatal: if memory flush fails, allow compaction to proceed
            }
        }
        // Don't cancel compaction
        return {};
    });
};
export default compactionGuard;
