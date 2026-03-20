export class CommandHandler {
    commands = new Map();
    aliases = new Map();
    register(command, executor) {
        this.commands.set(command, executor);
    }
    registerAlias(alias, target) {
        this.aliases.set(alias, target);
    }
    async execute(text, context) {
        const trimmed = text.trim();
        if (!trimmed.startsWith("/"))
            return null;
        const parts = trimmed.split(/\s+/);
        let cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        // Resolve aliases
        if (this.aliases.has(cmd)) {
            cmd = this.aliases.get(cmd);
        }
        const executor = this.commands.get(cmd);
        if (!executor) {
            // Check if it's a directive embedded in a message
            // e.g., "/model haiku 帮我分析这个问题"
            const directive = this.commands.get(cmd);
            if (!directive)
                return null;
        }
        return executor.execute(args, context);
    }
}
