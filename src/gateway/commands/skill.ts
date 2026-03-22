import type { CommandExecutor, CommandContext } from "./command-handler.js"
import { SkillLoader } from "../../skills/skill-loader.js"
import { resolveSkillSearchPaths } from "../../skills/search-paths.js"

export const skillCommand: CommandExecutor = {
  async execute(args: string[], ctx: CommandContext): Promise<string> {
    const skillName = args[0]
    if (!skillName) {
      const skills = await ctx.brain.listSkills()
      return skills.length === 0 ? "No skills available." : `Available skills: ${skills.join(", ")}`
    }

    const loader = new SkillLoader(resolveSkillSearchPaths(ctx.config))
    await loader.loadAll()
    const { content } = await loader.readSkillContent(skillName)
    const input = args.slice(1).join(" ").trim()
    if (!input) {
      return content
    }

    const result = await ctx.brain.handleMessage({
      text: `Use the following skill as instructions.\n\n[SKILL: ${skillName}]\n${content}\n\nUser request: ${input}`,
      channel: ctx.channel,
      senderId: ctx.senderId,
      sessionKey: ctx.sessionKey,
      isDm: true,
    })
    return result.text || "[No response]"
  },
}
