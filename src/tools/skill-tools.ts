import { Type } from "@sinclair/typebox"
import type { ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { ToolRegistryEntry } from "./index.js"
import { SkillLoader } from "../skills/skill-loader.js"

export function createSkillTools(skillPaths: string[]): ToolRegistryEntry[] {
  const loader = new SkillLoader(skillPaths)
  const readSkill: ToolDefinition = {
    name: "read_skill",
    label: "Read Skill",
    description: "Read a SKILL definition file",
    parameters: Type.Object({
      skill_name: Type.String({ description: "SKILL name" }),
    }),
    async execute(_id, params: any) {
      await loader.loadAll()
      try {
        const { content, references } = await loader.readSkillContent(params.skill_name)
        const appendix = references.length > 0
          ? `\n\nAvailable references:\n${references.map((ref) => `- ${ref}`).join("\n")}`
          : ""
        return {
          content: [{ type: "text" as const, text: `${content}${appendix}` }],
          details: undefined,
        }
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          details: undefined,
        }
      }
    },
  }

  const skillsList: ToolDefinition = {
    name: "skills_list",
    label: "Skills List",
    description: "List currently available SKILLs",
    parameters: Type.Object({}),
    async execute() {
      const skills = await loader.loadAll()
      const text = skills.length === 0
        ? "No skills available."
        : skills.map((skill) =>
          `${skill.name} — ${skill.description || "No description"}${skill.spawnable ? " [spawnable]" : ""}`
        ).join("\n")
      return {
        content: [{ type: "text" as const, text }],
        details: undefined,
      }
    },
  }

  return [
    { name: "read_skill", description: readSkill.description, group: "skill", tool: readSkill },
    { name: "skills_list", description: skillsList.description, group: "skill", tool: skillsList },
  ]
}
