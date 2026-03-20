export class ToolRegistry {
    entries = new Map();
    register(entry) {
        this.entries.set(entry.name, entry);
    }
    getAll() {
        return Array.from(this.entries.values());
    }
    getByGroup(group) {
        return this.getAll().filter((e) => e.group === group);
    }
    /** Return all tool definitions for passing to createAgentSession({ customTools }) */
    getPiTools() {
        return this.getAll().map((e) => e.tool);
    }
    /** Return "name — description" list for System Prompt Section 2 */
    getToolSummary() {
        return this.getAll()
            .map((e) => `${e.name} — ${e.description}`)
            .join("\n");
    }
    get(name) {
        return this.entries.get(name);
    }
    get size() {
        return this.entries.size;
    }
}
