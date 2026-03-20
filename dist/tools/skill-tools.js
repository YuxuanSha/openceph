import { Type } from "@sinclair/typebox";
import { SkillLoader } from "../skills/skill-loader.js";
export function createSkillTools(skillPaths) {
    const loader = new SkillLoader(skillPaths);
    const readSkill = {
        name: "read_skill",
        label: "Read Skill",
        description: "读取 SKILL 定义文件",
        parameters: Type.Object({
            skill_name: Type.String({ description: "SKILL 名称" }),
        }),
        async execute(_id, params) {
            await loader.loadAll();
            try {
                const { content, references } = await loader.readSkillContent(params.skill_name);
                const appendix = references.length > 0
                    ? `\n\nAvailable references:\n${references.map((ref) => `- ${ref}`).join("\n")}`
                    : "";
                return {
                    content: [{ type: "text", text: `${content}${appendix}` }],
                    details: undefined,
                };
            }
            catch (error) {
                return {
                    content: [{ type: "text", text: `Error: ${error.message}` }],
                    details: undefined,
                };
            }
        },
    };
    const skillsList = {
        name: "skills_list",
        label: "Skills List",
        description: "列出当前可用的 SKILL",
        parameters: Type.Object({}),
        async execute() {
            const skills = await loader.loadAll();
            const text = skills.length === 0
                ? "No skills available."
                : skills.map((skill) => `${skill.name} — ${skill.description || "No description"}${skill.spawnable ? " [spawnable]" : ""}`).join("\n");
            return {
                content: [{ type: "text", text }],
                details: undefined,
            };
        },
    };
    return [
        { name: "read_skill", description: readSkill.description, group: "skill", tool: readSkill },
        { name: "skills_list", description: skillsList.description, group: "skill", tool: skillsList },
    ];
}
